import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth";

const dbPath = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/local.sqlite";

async function main() {
  console.log("Seeding database...");

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });

  // Create admin user
  const adminPasswordHash = await hashPassword("admin123");
  const adminId = crypto.randomUUID();
  db.insert(schema.users).values({
    id: adminId,
    email: "admin@takemetothefair.com",
    name: "Admin User",
    passwordHash: adminPasswordHash,
    role: "ADMIN",
    emailVerified: new Date(),
  }).run();
  console.log("Created admin user: admin@takemetothefair.com");

  // Create promoter user
  const promoterPasswordHash = await hashPassword("promoter123");
  const promoterUserId = crypto.randomUUID();
  db.insert(schema.users).values({
    id: promoterUserId,
    email: "promoter@example.com",
    name: "John Promoter",
    passwordHash: promoterPasswordHash,
    role: "PROMOTER",
    emailVerified: new Date(),
  }).run();

  const promoterId = crypto.randomUUID();
  db.insert(schema.promoters).values({
    id: promoterId,
    userId: promoterUserId,
    companyName: "Fair Events Co.",
    slug: "fair-events-co",
    description: "We organize the best fairs and festivals in the region!",
    website: "https://faireventsco.example.com",
    verified: true,
  }).run();
  console.log("Created promoter: Fair Events Co.");

  // Create vendor user
  const vendorPasswordHash = await hashPassword("vendor123");
  const vendorUserId = crypto.randomUUID();
  db.insert(schema.users).values({
    id: vendorUserId,
    email: "vendor@example.com",
    name: "Jane Vendor",
    passwordHash: vendorPasswordHash,
    role: "VENDOR",
    emailVerified: new Date(),
  }).run();

  const vendorId = crypto.randomUUID();
  db.insert(schema.vendors).values({
    id: vendorId,
    userId: vendorUserId,
    businessName: "Artisan Crafts",
    slug: "artisan-crafts",
    description: "Handmade crafts and artisan goods",
    vendorType: "Arts & Crafts",
    products: JSON.stringify(["Pottery", "Jewelry", "Woodwork"]),
    verified: true,
  }).run();
  console.log("Created vendor: Artisan Crafts");

  // Create venues
  const venue1Id = crypto.randomUUID();
  db.insert(schema.venues).values({
    id: venue1Id,
    name: "County Fairgrounds",
    slug: "county-fairgrounds",
    address: "1234 Fair Lane",
    city: "Springfield",
    state: "IL",
    zip: "62701",
    latitude: 39.7817,
    longitude: -89.6501,
    capacity: 50000,
    amenities: JSON.stringify(["Parking", "Food Court", "Restrooms", "First Aid", "ATM"]),
    contactEmail: "info@countyfairgrounds.example.com",
    contactPhone: "(555) 123-4567",
    description: "The largest fairgrounds in the county, hosting events year-round.",
    status: "ACTIVE",
  }).run();
  console.log("Created venue: County Fairgrounds");

  const venue2Id = crypto.randomUUID();
  db.insert(schema.venues).values({
    id: venue2Id,
    name: "Riverside Park",
    slug: "riverside-park",
    address: "500 River Road",
    city: "Austin",
    state: "TX",
    zip: "78701",
    latitude: 30.2672,
    longitude: -97.7431,
    capacity: 15000,
    amenities: JSON.stringify(["Parking", "Picnic Areas", "Restrooms", "Playground"]),
    contactEmail: "parks@austin.example.gov",
    description: "Beautiful park along the river, perfect for outdoor events.",
    status: "ACTIVE",
  }).run();
  console.log("Created venue: Riverside Park");

  const venue3Id = crypto.randomUUID();
  db.insert(schema.venues).values({
    id: venue3Id,
    name: "Downtown Convention Center",
    slug: "downtown-convention-center",
    address: "100 Main Street",
    city: "Chicago",
    state: "IL",
    zip: "60601",
    latitude: 41.8781,
    longitude: -87.6298,
    capacity: 25000,
    amenities: JSON.stringify(["Parking Garage", "Food Court", "WiFi", "ADA Accessible"]),
    contactEmail: "events@chicagocc.example.com",
    contactPhone: "(555) 987-6543",
    description: "State-of-the-art convention center in the heart of downtown.",
    status: "ACTIVE",
  }).run();
  console.log("Created venue: Downtown Convention Center");

  // Create events
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  const twoMonthsOut = new Date(now.getFullYear(), now.getMonth() + 2, 1);

  const event1Id = crypto.randomUUID();
  db.insert(schema.events).values({
    id: event1Id,
    name: "Summer County Fair 2025",
    slug: "summer-county-fair-2025",
    description: "Join us for the biggest summer fair in the county! Featuring live music, carnival rides, agricultural exhibits, and delicious fair food. Fun for the whole family!",
    promoterId: promoterId,
    venueId: venue1Id,
    startDate: nextMonth,
    endDate: new Date(nextMonth.getTime() + 7 * 24 * 60 * 60 * 1000),
    categories: JSON.stringify(["Fair", "Family", "Agriculture"]),
    tags: JSON.stringify(["summer", "carnival", "rides", "food", "music"]),
    ticketPriceMin: 10,
    ticketPriceMax: 25,
    ticketUrl: "https://tickets.example.com/summer-fair",
    featured: true,
    status: "APPROVED",
  }).run();
  console.log("Created event: Summer County Fair 2025");

  const event2Id = crypto.randomUUID();
  db.insert(schema.events).values({
    id: event2Id,
    name: "Artisan Market Festival",
    slug: "artisan-market-festival",
    description: "Discover unique handmade goods from local artisans. Browse jewelry, pottery, woodwork, textiles, and more. Live demonstrations and workshops available.",
    promoterId: promoterId,
    venueId: venue2Id,
    startDate: twoMonthsOut,
    endDate: new Date(twoMonthsOut.getTime() + 2 * 24 * 60 * 60 * 1000),
    categories: JSON.stringify(["Market", "Arts & Crafts"]),
    tags: JSON.stringify(["artisan", "handmade", "crafts", "shopping"]),
    ticketPriceMin: 0,
    ticketPriceMax: 5,
    featured: true,
    status: "APPROVED",
  }).run();
  console.log("Created event: Artisan Market Festival");

  const event3Id = crypto.randomUUID();
  db.insert(schema.events).values({
    id: event3Id,
    name: "Holiday Craft Show",
    slug: "holiday-craft-show",
    description: "Get a head start on holiday shopping! Over 200 vendors selling handmade gifts, decorations, and treats. Perfect for finding unique presents.",
    promoterId: promoterId,
    venueId: venue3Id,
    startDate: new Date(now.getFullYear(), 11, 1),
    endDate: new Date(now.getFullYear(), 11, 3),
    categories: JSON.stringify(["Market", "Holiday"]),
    tags: JSON.stringify(["holiday", "christmas", "gifts", "crafts"]),
    ticketPriceMin: 5,
    ticketPriceMax: 10,
    featured: false,
    status: "APPROVED",
  }).run();
  console.log("Created event: Holiday Craft Show");

  // Add vendor to events
  db.insert(schema.eventVendors).values({
    id: crypto.randomUUID(),
    eventId: event1Id,
    vendorId: vendorId,
    boothInfo: "Booth A-15, Arts & Crafts Section",
    status: "APPROVED",
  }).run();

  db.insert(schema.eventVendors).values({
    id: crypto.randomUUID(),
    eventId: event2Id,
    vendorId: vendorId,
    boothInfo: "Main Pavilion, Booth 42",
    status: "APPROVED",
  }).run();

  sqlite.close();

  console.log("\nDatabase seeded successfully!");
  console.log("\nTest Accounts:");
  console.log("  Admin: admin@takemetothefair.com / admin123");
  console.log("  Promoter: promoter@example.com / promoter123");
  console.log("  Vendor: vendor@example.com / vendor123");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
