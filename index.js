#!/usr/bin/env node

const http = require("http");
const https = require("https");
const { program } = require("commander");
const crypto = require("crypto"); // For hashing request bodies

// Simple in-memory cache (replace with a more robust solution for production)
const cache = new Map();

// Function to generate a cache key (includes method and body hash for POST requests)
const generateCacheKey = (req) => {
  let key = `${req.method}|${req.url}`;
  if (req.method === "POST") {
    req.on("data", (chunk) => {
      key += `|${crypto.createHash("sha256").update(chunk).digest("hex")}`;
    });
  }
  return key;
};

// Function to fetch data from origin and cache it
const fetchFromOrigin = (origin, path, req, res) => {
  const targetUrl = new URL(path, origin);
  const protocol = targetUrl.protocol === "https:" ? https : http;
  const key = generateCacheKey(req);

  const proxyReq = protocol.request(
    targetUrl,
    { method: req.method },
    (proxyRes) => {
      let data = [];
      proxyRes.on("data", (chunk) => {
        data.push(chunk);
      });
      proxyRes.on("end", () => {
        const body = Buffer.concat(data);
        const statusCode = proxyRes.statusCode;

        // Handle redirects (with a limit to prevent infinite loops)
        let redirectCount = 0;
        const handleRedirect = (redirectUrl) => {
          if (redirectCount > 5) {
            console.error("Too many redirects!");
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Too many redirects");
            return;
          }
          redirectCount++;
          fetchFromOrigin(origin, redirectUrl.replace(origin, ""), req, res);
        };

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          proxyRes.headers.location
        ) {
          const redirectUrl = new URL(
            proxyRes.headers.location,
            targetUrl.origin
          ).href;
          console.log(`Redirecting to ${redirectUrl}`);
          handleRedirect(redirectUrl);
        } else {
          if (statusCode >= 200 && statusCode < 300) {
            cache.set(key, { headers: proxyRes.headers, body: body });
            console.log(
              `Caching response for ${key} with status ${statusCode}`
            );
            res.setHeader("X-Cache", "MISS"); // Response is from the origin server
          } else {
            console.log(
              `Received non-cacheable response (${statusCode}) for ${key}`
            );
          }
          res.writeHead(statusCode, proxyRes.headers);
          res.end(body);
        }
      });
    }
  );

  proxyReq.on("error", (err) => {
    console.error("Error fetching from origin:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Error fetching from origin: " + err.message);
  });

  req.pipe(proxyReq);
};

// Function to handle incoming requests
const handleRequest = (origin, req, res) => {
  const key = generateCacheKey(req);
  console.log(`Checking cache for ${key}`);

  if (cache.has(key)) {
    console.log(`Serving cached response for ${key}`);
    const cachedResponse = cache.get(key);
    res.setHeader("X-Cache", "HIT");
    res.writeHead(200, cachedResponse.headers);
    res.end(cachedResponse.body);
  } else {
    console.log(`Cache miss for ${key}. Fetching new response...`);
    fetchFromOrigin(origin, req.url, req, res);
  }
};

// Function to clear the cache
const clearCache = () => {
  cache.clear();
  console.log("Cache cleared successfully.");
};

// Set up the CLI arguments using commander
program
  .option("--port <number>", "Port on which the caching proxy server will run")
  .option(
    "--origin <url>",
    "The origin URL to which the requests will be forwarded"
  )
  .option("--clear-cache", "Clear the cache and exit process");

// Parse the command-line arguments
program.parse(process.argv);
const { port, origin, clearCache: clearCacheOption } = program.opts();

// If --clear-cache option is provided, clear the cache and exit
if (clearCacheOption) {
  clearCache();
  process.exit(0);
}

// Check if both port and origin are provided to run the proxy
if (!port || !origin) {
  console.error(
    "Error: You must specify both --port and --origin unless using --clear-cache."
  );
  process.exit(1);
}

// Create the proxy server
const server = http.createServer((req, res) => {
  handleRequest(origin, req, res);
});

// Start the server
server.listen(port, () => {
  console.log(`Caching Proxy running on port ${port}, forwarding to ${origin}`);
});
