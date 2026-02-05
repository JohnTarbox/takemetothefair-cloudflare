export const config = {
  baseUrl: "https://meetmeatthefair.com",
  sitemapUrl: "https://meetmeatthefair.com/sitemap.xml",
  googleTestUrl: "https://search.google.com/test/rich-results",
  outputDir: "gvalidate-results",
  timeouts: {
    pageLoad: 30000,
    testComplete: 120000, // 2 minutes for Google to analyze URL
    betweenTests: 3000, // 3s delay between tests (rate limiting)
  },
};
