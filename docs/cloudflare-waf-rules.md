# Cloudflare WAF Configuration Guide

Configure these rules in the Cloudflare Dashboard for comprehensive security.

## WAF Custom Rules

Go to **Security > WAF > Custom Rules** and create each rule.

---

### CRITICAL Priority

#### Rule 1: Admin Geo-Block
Restrict admin access to US and Canada only.

```
(http.request.uri.path starts with "/api/admin" or http.request.uri.path starts with "/admin") and not (ip.geoip.country in {"US" "CA"})
```
- **Action:** Block

#### Rule 2: Admin High Threat Score
Block suspicious IPs from admin APIs.

```
(http.request.uri.path starts with "/api/admin") and (cf.threat_score > 20)
```
- **Action:** Block

#### Rule 3: Database Endpoints Block
Block public access to database endpoints (use Zone Lockdown to whitelist admin IPs).

```
http.request.uri.path contains "/api/admin/database"
```
- **Action:** Block

---

### HIGH Priority

#### Rule 4: Registration Bot User Agents
Block scripted registration attempts.

```
(http.request.uri.path eq "/api/auth/register") and (http.user_agent contains "curl" or http.user_agent contains "wget" or http.user_agent contains "python" or http.user_agent contains "scrapy" or http.user_agent contains "bot" or http.user_agent contains "spider" or http.user_agent eq "")
```
- **Action:** Block

#### Rule 5: Registration Missing Browser Headers
Challenge requests missing typical browser headers.

```
(http.request.uri.path eq "/api/auth/register") and (not any(http.request.headers["accept-language"][*] contains "en"))
```
- **Action:** Managed Challenge

#### Rule 6: Auth Brute Force Protection
Challenge suspicious IPs on auth endpoints.

```
(http.request.uri.path contains "/api/auth") and (http.request.method eq "POST") and (cf.threat_score > 10)
```
- **Action:** Managed Challenge

#### Rule 7: Export Endpoints Challenge
Ensure humans are requesting bulk data exports.

```
http.request.uri.path contains "/export"
```
- **Action:** Managed Challenge

#### Rule 8: API Scraping Bot Detection
Challenge likely bots on public API endpoints.

```
(http.request.uri.path starts with "/api/events" or http.request.uri.path starts with "/api/venues" or http.request.uri.path starts with "/api/vendors") and (cf.client.bot)
```
- **Action:** Managed Challenge

---

### MEDIUM Priority

#### Rule 9: Cloud Provider ASN Block
Block cloud server IPs on sensitive endpoints (bots often run from cloud providers).

```
(http.request.uri.path eq "/api/auth/register" or http.request.uri.path contains "/api/admin") and (ip.geoip.asnum in {14061 16509 15169 8075 20473 63949})
```
- **Action:** Block
- **ASNs:** DigitalOcean (14061), AWS (16509), Google (15169), Azure (8075), Vultr (20473), Linode (63949)

#### Rule 10: SQL Injection Patterns
Block obvious SQL injection attempts at the edge.

```
(lower(http.request.uri.query) contains "union" or lower(http.request.uri.query) contains "select" or lower(http.request.uri.query) contains "insert" or lower(http.request.uri.query) contains "drop" or http.request.uri.query contains "1=1" or http.request.uri.query contains "../")
```
- **Action:** Block

#### Rule 11: Scanner User Agents
Block known security scanning tools.

```
(lower(http.user_agent) contains "sqlmap" or lower(http.user_agent) contains "nikto" or lower(http.user_agent) contains "nmap" or lower(http.user_agent) contains "masscan" or lower(http.user_agent) contains "zgrab" or lower(http.user_agent) contains "nuclei")
```
- **Action:** Block

---

### LOW Priority (Optional)

#### Rule 12: High-Risk Countries on Auth
Challenge auth requests from high-fraud regions.

```
(http.request.uri.path starts with "/api/auth") and (ip.geoip.country in {"RU" "CN" "KP" "IR"})
```
- **Action:** Managed Challenge

#### Rule 13: Suggest-Event Non-US Challenge
Challenge event suggestions from outside primary service area.

```
(http.request.uri.path starts with "/api/suggest-event") and (not ip.geoip.country in {"US" "CA"})
```
- **Action:** Managed Challenge

---

## Rate Limiting Rules

Go to **Security > WAF > Rate Limiting Rules**.

| Name | Expression | Requests | Period | Action | Duration |
|------|------------|----------|--------|--------|----------|
| Registration limit | `http.request.uri.path eq "/api/auth/register"` | 5 | 10 minutes | Block | 1 hour |
| Login limit | `http.request.uri.path contains "/api/auth/callback"` | 10 | 5 minutes | Managed Challenge | 10 minutes |
| Export limit | `http.request.uri.path contains "/export"` | 10 | 1 hour | Block | 1 hour |
| Admin limit | `http.request.uri.path starts with "/api/admin"` | 100 | 1 minute | Block | 10 minutes |

---

## Zone Lockdown

Go to **Security > WAF > Tools > Zone Lockdown**.

Create a lockdown rule for database endpoints:

| URL Pattern | Allowed IPs |
|-------------|-------------|
| `/api/admin/database/*` | Your admin IP addresses |

**How to find your IP:** Visit https://whatismyipaddress.com/

---

## Security Level Settings

Go to **Security > Settings** or create Page Rules:

| Path Pattern | Security Level |
|--------------|----------------|
| `/admin/*` | High |
| `/api/admin/*` | High |
| `/api/auth/register` | High |
| `/*` (default) | Medium |

---

## Bot Management

Go to **Security > Bots**:

- Enable **Bot Fight Mode** (free tier)
- Enable **Super Bot Fight Mode** if on Pro+ plan

---

## Verification Checklist

After configuring, verify:

- [ ] Admin routes blocked from VPN (different country)
- [ ] Rapid registration attempts hit rate limit
- [ ] Export endpoints trigger challenge
- [ ] Database endpoints return 403 for non-whitelisted IPs
- [ ] Bot user agents are blocked on registration

---

## Code-Level Security (Already Implemented)

These protections are implemented in the application code:

- ✅ Turnstile bot protection on registration
- ✅ Rate limiting via Cloudflare KV (registration, exports)
- ✅ Geo-blocking on database backup/restore routes
- ✅ Role-based access control (ADMIN, PROMOTER, VENDOR, USER)
- ✅ SSRF protection for URL fetching
