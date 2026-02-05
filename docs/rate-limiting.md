# Rate Limiting Configuration

This project runs on Cloudflare Pages, which means rate limiting should be configured at the Cloudflare edge rather than in application code.

## Recommended Cloudflare Rate Limiting Rules

### Registration Endpoint
- **URL Pattern:** `/api/auth/register`
- **Threshold:** 5 requests per 10 minutes per IP
- **Action:** Challenge or Block
- **Rationale:** Prevents automated account creation

### Login Endpoint
- **URL Pattern:** `/api/auth/callback/credentials`
- **Threshold:** 10 requests per 10 minutes per IP
- **Action:** Challenge
- **Rationale:** Prevents brute-force password attacks

### Contact Form
- **URL Pattern:** `/api/contact`
- **Threshold:** 3 requests per 10 minutes per IP
- **Action:** Challenge
- **Rationale:** Prevents spam submissions

### API Import Endpoints (Admin)
- **URL Pattern:** `/api/admin/import-url/*`
- **Threshold:** 20 requests per minute per IP
- **Action:** Log (already requires admin auth)
- **Rationale:** AI extraction is resource-intensive

## How to Configure

### Via Cloudflare Dashboard

1. Go to your domain in Cloudflare Dashboard
2. Navigate to **Security** > **WAF** > **Rate limiting rules**
3. Click **Create rule**
4. Configure:
   - Rule name: (e.g., "Registration Rate Limit")
   - If: URI Path equals `/api/auth/register`
   - And: Request method equals `POST`
   - Rate: 5 requests per 10 minutes
   - With characteristics: IP
   - Then: Block (or Challenge)

### Via Cloudflare API / Terraform

```hcl
resource "cloudflare_rate_limit" "registration" {
  zone_id = var.zone_id

  threshold = 5
  period    = 600  # 10 minutes

  match {
    request {
      url_pattern = "${var.domain}/api/auth/register"
      methods     = ["POST"]
    }
  }

  action {
    mode = "challenge"
  }
}
```

## In-App Protection

The application includes these built-in protections:

1. **Input Validation**: All endpoints validate input with Zod schemas
2. **Password Hashing**: Uses PBKDF2 with 100,000 iterations (timing-safe)
3. **Error Logging**: Failed attempts are logged for monitoring
4. **Generic Error Messages**: Doesn't leak whether email exists

## Monitoring

Check these in Cloudflare Analytics:

- **Security** > **Overview**: Rate limiting blocks
- **Security** > **Events**: Individual blocked requests
- **Workers/Pages** > **Logs**: Application-level errors

## Additional Recommendations

1. **Enable Cloudflare Bot Management** if available (Enterprise)
2. **Use Turnstile** on public forms for additional bot protection
3. **Monitor error logs** in `/admin/logs` for suspicious patterns
4. **Review WAF events** regularly for attack patterns
