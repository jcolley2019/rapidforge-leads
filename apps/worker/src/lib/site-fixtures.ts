/**
 * Fixture homepage HTML — per-host documents served by FixtureSiteFetcher
 * (Sprint 3) so Conversion parsing, platform fingerprinting, copyright
 * extraction, and NAP comparison all run for real against offline data.
 *
 * Each document is crafted to exercise specific detection paths; NAP data
 * intentionally matches or mismatches the Places fixture record:
 *
 *   NAP phone mismatch   boisedrainpros (old number) · vistaheatcool
 *   NAP address missing  starplumbingidaho
 *   no tel: link         boisedrainpros · meridiancomfort · starplumbing ·
 *                        meridianwaterheater · gcgaragedoor
 *   no viewport meta     meridianwaterheater
 *   stale copyright      boisedrainpros 2021 · meridiancomfort 2022 ·
 *                        starplumbing 2019 · meridianwaterheater 2013
 *   response >2s         boisedrainpros · meridiancomfort · meridianwaterheater
 */

export interface SiteFixture {
  html: string;
  /** Lowercased header names, as FetchedSite delivers them. */
  headers: Record<string, string>;
  responseMs: number;
  httpStatus: number;
  /** SEO agent (S6): /sitemap.xml exists. Absent = false. Builders auto-generate one. */
  hasSitemap?: boolean;
  /** SEO agent (S6): /robots.txt exists. Absent = false. */
  hasRobots?: boolean;
}

export const SITE_FIXTURES: Readonly<Record<string, SiteFixture>> = {
  // fx-001 — great custom site: every conversion signal, schema, fresh.
  "snakeriverplumbing.com": {
    responseMs: 310,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "nginx", "last-modified": "Sat, 20 Jun 2026 08:12:00 GMT" },
    html: `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snake River Plumbing Co | Meridian ID Plumber</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Snake River Plumbing Co","telephone":"(208) 555-0101","address":{"streetAddress":"1120 N Main St","addressLocality":"Meridian","addressRegion":"ID","postalCode":"83642"}}</script>
</head><body>
<header><a class="btn btn-primary" href="tel:+12085550101">Call (208) 555-0101</a>
<a class="btn" href="https://calendly.com/snakeriverplumbing/service">Request Service Today</a></header>
<main><h1>Meridian&rsquo;s Trusted Plumbers Since 2004</h1>
<p>24/7 emergency plumbing across the Treasure Valley.</p>
<form action="/contact" method="post">
<input name="name"><input name="email"><input name="phone"><select name="service"><option>Drain</option></select><textarea name="message"></textarea>
<button type="submit">Get My Free Quote</button></form></main>
<footer><p>1120 N Main St, Meridian, ID 83642</p>
<a href="https://www.facebook.com/snakeriverplumbing">Facebook</a>
<p>&copy; 2026 Snake River Plumbing Co</p></footer>
</body></html>`,
  },

  // fx-002 — terrible Wix build: no tel link, wrong (old) phone, stale.
  "boisedrainpros.wixsite.com": {
    responseMs: 2400,
    httpStatus: 200,
    hasSitemap: true, // Wix auto-generates one — the SEO problems live in the markup
    hasRobots: true,
    headers: { server: "Pepyaka", "x-wix-request-id": "abc123" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home | boisedrainpros</title>
<link rel="stylesheet" href="https://static.wixstatic.com/styles/site.css">
<script src="https://static.parastorage.com/services/wix-thunderbolt/app.js"></script>
</head><body>
<h1>Welcome to our website</h1>
<p>We are a plumbing company in Boise. Call us at (208) 555-9987.</p>
<img src="https://static.wixstatic.com/media/hero.jpg">
<form><input name="email"><textarea name="msg"></textarea><button>Send</button></form>
<footer><p>8990 W Overland Rd, Boise ID</p><p>&copy; 2021 Boise Drain Pros. Proudly created with Wix.com</p></footer>
</body></html>`,
  },

  // fx-006 — chain corporate site: polished, every signal present.
  "www.rotorooter.com": {
    responseMs: 280,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "cloudflare", "last-modified": "Wed, 01 Jul 2026 04:00:00 GMT" },
    html: `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roto-Rooter Plumbing &amp; Water Cleanup — Boise, ID</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Roto-Rooter Plumbing & Water Cleanup","telephone":"(208) 555-0106"}</script>
</head><body>
<header><a href="tel:+12085550106" class="cta">Call Now (208) 555-0106</a>
<a href="/schedule-service" class="cta">Schedule Service Online</a></header>
<main><h1>Boise Plumbing &amp; Drain Service</h1>
<form action="/estimate"><input name="zip"><input name="phone"><input name="issue"><button>Book Your Appointment</button></form>
<script src="https://cdn.livechatinc.com/tracking.js"></script></main>
<footer><p>6110 W Emerald St, Boise, ID 83704</p>
<a href="https://www.facebook.com/rotorooter">Facebook</a>
<p>&copy; 2026 Roto-Rooter LLC</p></footer>
</body></html>`,
  },

  // fx-009/010/011 — mediocre WordPress, NAP consistent, no booking/chat.
  "boiseplumbingco.com": {
    responseMs: 940,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "apache", "x-powered-by": "PHP/8.1", "last-modified": "Mon, 10 Nov 2025 16:40:00 GMT" },
    html: `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="WordPress 6.4">
<title>Boise Plumbing Co — Plumbers in Boise, Idaho</title>
<link rel="stylesheet" href="/wp-content/themes/plumberpress/style.css">
</head><body>
<h1>Boise Plumbing Co</h1>
<p>Family-owned since 1987. Call <a href="tel:+12085550109">(208) 555-0109</a>.</p>
<div class="locations">802 W Bannock St, Boise, ID 83702 &middot; 10400 W Overland Rd &middot; 2210 S Federal Way</div>
<form action="/wp-admin/admin-ajax.php"><input name="name"><input name="email"><input name="phone"><input name="address"><input name="city"><select name="service"></select><textarea name="details"></textarea><button>Submit Request</button></form>
<script src="/wp-includes/js/jquery/jquery.min.js"></script>
<footer>&copy; 2024 Boise Plumbing Co</footer>
</body></html>`,
  },

  // fx-012 — GoDaddy builder: mailto only, no tel link, no form, stale.
  "meridiancomfort.godaddysites.com": {
    responseMs: 2100,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "DPS/2.0" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian Comfort Heating and Air</title>
<link rel="preconnect" href="https://img.wsimg.com">
<img src="https://img.wsimg.com/isteam/ip/hero.jpg">
</head><body>
<h1>Meridian Comfort Heating &amp; Air</h1>
<p>Heating and cooling for the Treasure Valley. Phone: (208) 555-0112</p>
<p><a href="mailto:info@meridiancomfort.example">Email us</a></p>
<footer><p>3327 N Eagle Rd, Meridian, ID 83646</p>
<p>&copy; 2022 &middot; Website Builder by GoDaddy</p></footer>
</body></html>`,
  },

  // fx-013 — decent Squarespace: tel + form + CTA, no booking/schema.
  "kunaelectric.squarespace.com": {
    responseMs: 620,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "Squarespace" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kuna Electric — Licensed Electricians</title>
<link rel="stylesheet" href="https://static1.squarespace.com/static/site.css">
</head><body>
<header><a href="tel:+12085550113" class="sqs-button">Get a Free Estimate — (208) 555-0113</a></header>
<h1>Kuna Electric</h1>
<form action="/contact"><input name="name"><input name="email"><input name="phone"><textarea name="project"></textarea><button>Send</button></form>
<footer><p>751 W Main St, Kuna, ID 83634</p><p>&copy; 2025 Kuna Electric LLC</p></footer>
</body></html>`,
  },

  // fx-014 — aging WordPress.com: no tel link, address missing, © 2019.
  "starplumbingidaho.wordpress.com": {
    responseMs: 1350,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "nginx", "x-powered-by": "WordPress.com" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="WordPress.com">
<title>Star Plumbing &amp; Heating | Just another WordPress site</title>
<link rel="stylesheet" href="/wp-content/themes/twentyseventeen/style.css">
</head><body>
<h1>Star Plumbing &amp; Heating</h1>
<p>Serving Star and Eagle. Call us: (208) 555-0114</p>
<form><input name="name"><input name="email"><textarea name="comment"></textarea><button>Post Comment</button></form>
<footer><p>&copy; 2019 Star Plumbing &amp; Heating &middot; Blog at WordPress.com</p></footer>
</body></html>`,
  },

  // fx-017 — great Webflow: everything present, cal.com booking, crisp chat.
  "pipedreamidaho.webflow.io": {
    responseMs: 240,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "Webflow" },
    html: `<!doctype html><html data-wf-domain="pipedreamidaho.webflow.io" data-wf-page="abc"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Idaho Pipe Dream Plumbing — Garden City, ID</title>
<link rel="stylesheet" href="https://assets.website-files.com/site.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Idaho Pipe Dream Plumbing","telephone":"(208) 555-0117","address":{"streetAddress":"4720 W Chinden Blvd","addressLocality":"Garden City"}}</script>
</head><body>
<header><a href="tel:+12085550117">Call (208) 555-0117</a>
<a href="https://cal.com/pipedreamidaho/estimate" class="button">Book Now</a></header>
<h1>Modern Plumbing, Done Right</h1>
<form><input name="name"><input name="email"><input name="phone"><select name="service"></select><textarea name="details"></textarea><button>Request a Callback</button></form>
<script src="https://client.crisp.chat/l.js"></script>
<footer><p>4720 W Chinden Blvd, Garden City, ID 83714</p>
<a href="https://www.instagram.com/pipedreamidaho">Instagram</a>
<p>&copy; 2026 Idaho Pipe Dream Plumbing</p></footer>
</body></html>`,
  },

  // fx-018 — ancient hand-rolled site: no viewport, tables, © 2013.
  "meridianwaterheater.com": {
    responseMs: 3400,
    httpStatus: 200,
    headers: { server: "Apache/2.2.22 (Ubuntu)", "last-modified": "Tue, 18 Mar 2014 09:30:00 GMT" },
    html: `<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<title>Meridian Water Heater Repair - Welcome To Our Home Page</title>
</head><body bgcolor="#FFFFFF">
<table width="800" border="0"><tr><td>
<font face="Arial" size="4"><b>MERIDIAN WATER HEATER REPAIR</b></font><br>
<font size="2">Water heaters installed and repaired. Please call (208) 555-0118 between 8am and 5pm.</font>
<br><img src="waterheater.gif">
<font size="1">1830 W Franklin Rd, Meridian, ID 83642<br>
Copyright 2013 Meridian Water Heater Repair. All rights reserved.</font>
</td></tr></table>
</body></html>`,
  },

  // fx-019 — gate-skipped (CLOSED_TEMPORARILY); minimal but valid.
  "abcplumbingboise.com": {
    responseMs: 800,
    httpStatus: 200,
    headers: { server: "nginx" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ABC Plumbing of Boise</title></head><body>
<h1>ABC Plumbing of Boise</h1>
<p>Call <a href="tel:+12085550119">(208) 555-0119</a></p>
<footer><p>1420 N Orchard St, Boise, ID 83706</p><p>&copy; 2023 ABC Plumbing</p></footer>
</body></html>`,
  },

  // fx-022 — poor site, busy business: tel present but WRONG number (NAP
  // phone mismatch), 11-field form, stale-ish copyright.
  "vistaheatcool.com": {
    responseMs: 1900,
    httpStatus: 200,
    headers: { server: "apache" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vista Heating &amp; Cooling</title></head><body>
<h1>Vista Heating &amp; Cooling</h1>
<p>Boise HVAC service and installation. Call <a href="tel:+12085557744">(208) 555-7744</a>.</p>
<form action="/quote">
<input name="first"><input name="last"><input name="email"><input name="phone"><input name="address"><input name="city"><input name="state"><input name="zip"><select name="system"></select><select name="age"></select><textarea name="notes"></textarea>
<button>Submit</button></form>
<footer><p>2109 S Vista Ave, Boise, ID 83705</p><p>&copy; 2023 Vista Heating and Cooling</p></footer>
</body></html>`,
  },

  // fx-023 — mediocre custom: no phone anywhere (Places has none either),
  // tidio chat present, form present.
  "gcgaragedoor.com": {
    responseMs: 710,
    httpStatus: 200,
    headers: { server: "nginx", "last-modified": "Thu, 12 Feb 2026 11:00:00 GMT" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garden City Garage &amp; Door</title></head><body>
<h1>Garden City Garage &amp; Door</h1>
<p>Garage door repair and installation across Garden City and Boise.</p>
<form action="/contact"><input name="name"><input name="email"><input name="address"><select name="door_type"></select><input name="preferred_date"><textarea name="details"></textarea><button>Request Estimate</button></form>
<script src="//code.tidio.co/abc123.js" async></script>
<footer><p>3663 W Adams St, Garden City, ID 83714</p><p>&copy; 2025 Garden City Garage &amp; Door</p></footer>
</body></html>`,
  },

  // fx-025 — great custom site on the busiest shop: all signals, fresh.
  "precisionplumbingidaho.com": {
    responseMs: 350,
    httpStatus: 200,
    hasSitemap: true,
    hasRobots: true,
    headers: { server: "cloudflare", "last-modified": "Fri, 26 Jun 2026 19:05:00 GMT" },
    html: `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Precision Plumbing Idaho | Boise Plumbers</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Precision Plumbing Idaho","telephone":"(208) 555-0125","address":{"streetAddress":"980 S Capitol Blvd","addressLocality":"Boise","addressRegion":"ID","postalCode":"83702"}}</script>
</head><body>
<header><a href="tel:+12085550125" class="cta">Call (208) 555-0125</a>
<a href="https://book.housecallpro.com/book/precision-plumbing" class="cta">Schedule Service</a></header>
<h1>Boise&rsquo;s Highest-Rated Plumbing Team</h1>
<form action="/contact"><input name="name"><input name="phone"><input name="email"><textarea name="issue"></textarea><button>Get Help Now</button></form>
<script src="https://embed.tawk.to/xyz/default"></script>
<footer><p>980 S Capitol Blvd, Boise, ID 83702</p>
<a href="https://www.facebook.com/precisionplumbingidaho">Facebook</a>
<p>&copy; 2026 Precision Plumbing Idaho</p></footer>
</body></html>`,
  },
};

/**
 * Deterministic fallback page for hosts outside the fixture set — a plain
 * custom-platform page with minimal signals so half-live configurations
 * degrade gracefully instead of crashing.
 */
export function fallbackSiteFixture(host: string): SiteFixture {
  return {
    responseMs: 900,
    httpStatus: 200,
    headers: { server: "nginx" },
    html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${host}</title></head><body>
<h1>${host}</h1>
<p>Welcome to our website.</p>
<form action="/contact"><input name="name"><input name="email"><textarea name="message"></textarea><button>Send</button></form>
<footer><p>&copy; 2024</p></footer>
</body></html>`,
  };
}
