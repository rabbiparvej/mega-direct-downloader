
const http = require("http");
const { File } = require("megajs");

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      success: true,
      message: "MEGADL Download Server is running"
    }));
  }

  if (requestUrl.pathname !== "/download" || req.method !== "GET") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  const megaUrl = requestUrl.searchParams.get("url");

  if (!megaUrl) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "MEGA URL is required" }));
  }

  try {
    const parsed = new URL(megaUrl);

    if (
      !["mega.nz", "www.mega.nz", "mega.co.nz"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith("/file/")
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid MEGA link" }));
    }

    const file = File.fromURL(megaUrl);
    await file.loadAttributes();

    const filename = encodeURIComponent(file.name || "download");

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Content-Length": file.size
    });

    const download = file.download();

    download.on("error", (error) => {
      console.error("Download error:", error.message);
      res.destroy(error);
    });

    download.pipe(res);

  } catch (error) {
    console.error("Server error:", error.message);

    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: false,
        error: "Unable to download this MEGA file"
      }));
    } else {
      res.destroy(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MEGADL server running on port ${PORT}`);
});
