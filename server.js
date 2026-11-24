
const http = require("http");
const { File } = require("megajs");

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length, Content-Disposition"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      success: true,
      message: "MEGADL Download Server is running",
      rangeSupport: true
    }));
  }

  if (
    requestUrl.pathname !== "/download" ||
    !["GET", "HEAD"].includes(req.method)
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const megaUrl = requestUrl.searchParams.get("url");

  if (!megaUrl) {
    res.writeHead(400);
    return res.end("MEGA URL is required");
  }

  let download;

  try {
    const parsed = new URL(megaUrl);

    if (
      !["mega.nz", "www.mega.nz", "mega.co.nz"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith("/file/")
    ) {
      res.writeHead(400);
      return res.end("Invalid MEGA link");
    }

    const file = File.fromURL(megaUrl);
    await file.loadAttributes();

    const size = file.size;
    const filename = encodeURIComponent(file.name || "download");

    let start = 0;
    let end = size - 1;
    let statusCode = 200;

    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);

      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes"
        });
        return res.end();
      }

      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, {
            "Content-Range": `bytes */${size}`
          });
          return res.end();
        }
        start = Math.max(0, size - suffixLength);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= size ||
        end < start
      ) {
        res.writeHead(416, {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes"
        });
        return res.end();
      }

      end = Math.min(end, size - 1);
      statusCode = 206;
    }

    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1
    };

    if (statusCode === 206) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }

    res.writeHead(statusCode, headers);

    if (req.method === "HEAD") {
      return res.end();
    }

    download = file.download({ start, end });

    download.on("error", (error) => {
      console.error("Download error:", error.message);
      if (!res.destroyed) res.destroy(error);
    });

    req.on("aborted", () => {
      if (download && !download.destroyed) download.destroy();
    });

    res.on("close", () => {
      if (!res.writableEnded && download && !download.destroyed) {
        download.destroy();
      }
    });

    download.pipe(res);

  } catch (error) {
    console.error("Server error:", error.message);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        error: "Unable to download this MEGA file"
      }));
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MEGADL server running on port ${PORT}`);
});
