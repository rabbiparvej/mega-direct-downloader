
const http = require("http");
const { File } = require("megajs");

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://megadl-api-mion.onrender.com";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".webm",
  ".m4v", ".3gp", ".ts", ".mpg", ".mpeg",
  ".wmv", ".flv", ".ogv"
]);

function validMegaUrl(value, type) {
  try {
    const u = new URL(value);
    const hosts = ["mega.nz", "www.mega.nz", "mega.co.nz"];

    return hosts.includes(u.hostname) &&
      u.pathname.startsWith(type === "folder" ? "/folder/" : "/file/");
  } catch {
    return false;
  }
}

function getExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function collectVideos(folder) {
  const videos = [];

  function walk(directory, parentPath = "") {
    for (const item of directory.children || []) {
      const path = parentPath
        ? `${parentPath}/${item.name}`
        : item.name;

      if (item.children) {
        walk(item, path);
      } else if (VIDEO_EXTENSIONS.has(getExtension(item.name))) {
        videos.push({
          file: item,
          path
        });
      }
    }
  }

  walk(folder);
  return videos;
}

function findFileById(folder, id) {
  function walk(directory) {
    for (const item of directory.children || []) {
      if (String(item.nodeId) === String(id)) {
        return item;
      }

      if (item.children) {
        const found = walk(item);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(folder);
}

async function getDownloadFile(requestUrl) {
  const folderUrl = requestUrl.searchParams.get("folder");
  const fileId = requestUrl.searchParams.get("fileId");

  if (folderUrl && fileId) {
    if (!validMegaUrl(folderUrl, "folder")) {
      throw new Error("Invalid MEGA folder link");
    }

    const folder = File.fromURL(folderUrl);
    await folder.loadAttributes();

    const file = findFileById(folder, fileId);

    if (!file || file.children) {
      throw new Error("File not found in folder");
    }

    return file;
  }

  const megaUrl = requestUrl.searchParams.get("url");

  if (!megaUrl || !validMegaUrl(megaUrl, "file")) {
    throw new Error("Invalid MEGA file link");
  }

  const file = File.fromURL(megaUrl);
  await file.loadAttributes();

  return file;
}

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
      rangeSupport: true,
      folderScanner: true
    }));
  }

  // MEGA FOLDER SCANNER
  if (requestUrl.pathname === "/folder" && req.method === "GET") {
    try {
      const folderUrl = requestUrl.searchParams.get("url");

      if (!folderUrl || !validMegaUrl(folderUrl, "folder")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          success: false,
          error: "Invalid MEGA folder link"
        }));
      }

      const folder = File.fromURL(folderUrl);
      await folder.loadAttributes();

      const videos = collectVideos(folder);

      const result = videos.map((item, index) => ({
        serial: index + 1,
        name: item.file.name,
        path: item.path,
        size: item.file.size,
        sizeMB: (item.file.size / 1048576).toFixed(2),
        downloadUrl:
          `${BASE_URL}/download?folder=${encodeURIComponent(folderUrl)}` +
          `&fileId=${encodeURIComponent(item.file.nodeId)}`
      }));

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(JSON.stringify({
        success: true,
        totalVideos: result.length,
        videos: result
      }));

    } catch (error) {
      console.error("Folder scanner error:", error.message);

      res.writeHead(500, {
        "Content-Type": "application/json"
      });

      return res.end(JSON.stringify({
        success: false,
        error: "Unable to scan MEGA folder",
        details: error.message
      }));
    }
  }

  // DOWNLOAD + RANGE SUPPORT
  if (
    requestUrl.pathname !== "/download" ||
    !["GET", "HEAD"].includes(req.method)
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }

  let download;

  try {
    const file = await getDownloadFile(requestUrl);

    if (file.directory) {
      res.writeHead(400);
      return res.end("Cannot download a folder");
    }

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
        const suffix = Number(match[2]);

        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.writeHead(416, {
            "Content-Range": `bytes */${size}`
          });
          return res.end();
        }

        start = Math.max(0, size - suffix);
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

    download.on("error", error => {
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
        error: error.message || "Unable to download this MEGA file"
      }));
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MEGADL server running on port ${PORT}`);
});
