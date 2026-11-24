
const http = require("http");
const { File } = require("megajs");

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://megadl-api-mion.onrender.com";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".webm",
  ".m4v", ".3gp", ".ts", ".mpg", ".mpeg",
  ".wmv", ".flv", ".ogv"
]);

// ===============================
// MEGA URL VALIDATION
// ===============================

function validMegaUrl(value, type) {
  try {
    const u = new URL(value);
    const hosts = ["mega.nz", "www.mega.nz", "mega.co.nz"];

    return hosts.includes(u.hostname) &&
      u.pathname.startsWith(
        type === "folder" ? "/folder/" : "/file/"
      );
  } catch {
    return false;
  }
}

// ===============================
// HELPER FUNCTIONS
// ===============================

function getExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) {
    return "Unknown size";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];

  const index = Math.min(
    Math.floor(Math.log(Number(bytes)) / Math.log(1024)),
    units.length - 1
  );

  return (
    Number(bytes) / Math.pow(1024, index)
  ).toFixed(2) + " " + units[index];
}

// ===============================
// FOLDER VIDEO SCANNER
// ===============================

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

// ===============================
// PREMIUM HTML DASHBOARD
// ===============================

function renderFolderPage(videos, folderUrl) {
  const totalSize = videos.reduce(
    (sum, item) => sum + (Number(item.file.size) || 0),
    0
  );

  const cards = videos.map((item, index) => {
    const name = escapeHtml(item.file.name);
    const path = escapeHtml(item.path);
    const size = formatBytes(item.file.size);

    const extension = escapeHtml(
      getExtension(item.file.name)
        .replace(".", "")
        .toUpperCase()
    );

    const downloadUrl =
      `${BASE_URL}/download?folder=${encodeURIComponent(folderUrl)}` +
      `&fileId=${encodeURIComponent(item.file.nodeId)}`;

    return `
      <article class="video-card">

        <div class="card-top">
          <span class="serial">
            #${String(index + 1).padStart(2, "0")}
          </span>

          <span class="format">
            ${extension || "VIDEO"}
          </span>
        </div>

        <h3>${name}</h3>

        <p class="path">${path}</p>

        <div class="info">
          <span>📦 ${size}</span>
          <span>🎬 ${extension || "Video"} File</span>
        </div>

        <div class="actions">

          <button
            class="copy-btn"
            data-url="${escapeHtml(downloadUrl)}"
          >
            📋 Copy Link
          </button>

          <a
            class="download-btn"
            href="${escapeHtml(downloadUrl)}"
          >
            ⬇ Download
          </a>

        </div>

      </article>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">

<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>MEGADL - Premium Video Downloader</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #090d18;
  color: #f5f7ff;
  font-family: Arial, sans-serif;
  padding: 20px;
}

.container {
  max-width: 950px;
  margin: auto;
}

header {
  padding: 24px 0;
  border-bottom: 1px solid #252d40;
  margin-bottom: 24px;
}

.logo {
  font-size: 30px;
  font-weight: 900;
  letter-spacing: 1px;
}

.logo span {
  color: #38bdf8;
}

.subtitle {
  color: #94a3b8;
  font-size: 12px;
  margin-top: 7px;
  letter-spacing: 2px;
}

.status {
  display: inline-block;
  background: #123c32;
  color: #4ade80;
  padding: 7px 12px;
  border-radius: 20px;
  font-size: 12px;
  margin-top: 14px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 25px;
}

.stat {
  background: #141c2d;
  border: 1px solid #26334b;
  border-radius: 15px;
  padding: 18px;
}

.stat small {
  color: #94a3b8;
}

.stat h2 {
  font-size: 25px;
  margin: 9px 0 0;
}

.section-title {
  font-size: 19px;
  margin: 25px 0 15px;
}

.video-card {
  background: linear-gradient(145deg, #182238, #111827);
  border: 1px solid #293750;
  border-radius: 17px;
  padding: 18px;
  margin-bottom: 14px;
}

.card-top {
  display: flex;
  justify-content: space-between;
}

.serial {
  color: #38bdf8;
  font-weight: bold;
}

.format {
  background: #26364d;
  color: #93c5fd;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 11px;
}

.video-card h3 {
  font-size: 16px;
  overflow-wrap: anywhere;
  margin: 17px 0 7px;
}

.path {
  font-size: 12px;
  color: #94a3b8;
  overflow-wrap: anywhere;
}

.info {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  color: #aab8ce;
  font-size: 12px;
  margin: 17px 0;
}

.actions {
  display: flex;
  gap: 10px;
}

.actions button,
.actions a {
  flex: 1;
  text-align: center;
  padding: 13px 8px;
  border: 0;
  border-radius: 10px;
  font-size: 13px;
  font-weight: bold;
  text-decoration: none;
  cursor: pointer;
}

.copy-btn {
  background: #26364d;
  color: #e2e8f0;
}

.copy-btn:hover {
  background: #334b6a;
}

.download-btn {
  background: #0284c7;
  color: white;
}

.download-btn:hover {
  background: #0369a1;
}

.empty {
  text-align: center;
  padding: 35px;
  background: #141c2d;
  border-radius: 15px;
  color: #94a3b8;
}

footer {
  text-align: center;
  color: #64748b;
  font-size: 12px;
  padding: 30px 0;
}

@media(max-width: 450px) {

  body {
    padding: 14px;
  }

  .logo {
    font-size: 26px;
  }

  .actions {
    gap: 7px;
  }

  .actions button,
  .actions a {
    font-size: 12px;
  }

}

</style>
</head>

<body>

<div class="container">

<header>

  <div class="logo">
    MEGA<span>DL</span>
  </div>

  <div class="subtitle">
    PREMIUM VIDEO DOWNLOAD CENTER
  </div>

  <div class="status">
    ✓ Folder Scan Complete
  </div>

</header>

<div class="stats">

  <div class="stat">
    <small>TOTAL VIDEOS</small>
    <h2>${videos.length}</h2>
  </div>

  <div class="stat">
    <small>TOTAL SIZE</small>
    <h2>${formatBytes(totalSize)}</h2>
  </div>

</div>

<h2 class="section-title">
  Available Videos
</h2>

${cards || `
  <div class="empty">
    No supported video files found in this folder.
  </div>
`}

<footer>
  MEGADL · Premium Direct Download Service
</footer>

</div>

<script>

document.querySelectorAll(".copy-btn").forEach(button => {

  button.addEventListener("click", async () => {

    const url = button.dataset.url;

    try {

      await navigator.clipboard.writeText(url);
      button.textContent = "✓ Copied!";

    } catch {

      const input = document.createElement("textarea");

      input.value = url;
      document.body.appendChild(input);
      input.select();

      const copied = document.execCommand("copy");

      input.remove();

      button.textContent = copied
        ? "✓ Copied!"
        : "Copy Failed";

    }

    setTimeout(() => {
      button.textContent = "📋 Copy Link";
    }, 1800);

  });

});

</script>

</body>
</html>`;
}

// ===============================
// GET DOWNLOAD FILE
// ===============================

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

// ===============================
// HTTP SERVER
// ===============================

const server = http.createServer(async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length, Content-Disposition"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  // =============================
  // SERVER STATUS
  // =============================

  if (requestUrl.pathname === "/") {

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    return res.end(JSON.stringify({
      success: true,
      message: "MEGADL Download Server is running",
      rangeSupport: true,
      folderScanner: true,
      premiumDashboard: true
    }));

  }

  // =============================
  // MEGA FOLDER SCANNER
  // =============================

  if (
    requestUrl.pathname === "/folder" &&
    req.method === "GET"
  ) {

    try {

      const folderUrl = requestUrl.searchParams.get("url");

      if (!folderUrl || !validMegaUrl(folderUrl, "folder")) {

        res.writeHead(400, {
          "Content-Type": "application/json"
        });

        return res.end(JSON.stringify({
          success: false,
          error: "Invalid MEGA folder link"
        }));

      }

      const folder = File.fromURL(folderUrl);

      await folder.loadAttributes();

      const videos = collectVideos(folder);

      const result = videos.map((item, index) => {

        const downloadUrl =
          `${BASE_URL}/download?folder=${encodeURIComponent(folderUrl)}` +
          `&fileId=${encodeURIComponent(item.file.nodeId)}`;

        return {
          serial: index + 1,
          name: item.file.name,
          path: item.path,
          size: item.file.size,
          sizeMB: (
            item.file.size / 1048576
          ).toFixed(2),
          downloadUrl
        };

      });

      // JSON API MODE

      if (
        requestUrl.searchParams.get("format") === "json"
      ) {

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8"
        });

        return res.end(JSON.stringify({
          success: true,
          totalVideos: result.length,
          videos: result
        }));

      }

      // PREMIUM HTML MODE

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      return res.end(
        renderFolderPage(videos, folderUrl)
      );

    } catch (error) {

      console.error(
        "Folder scanner error:",
        error.message
      );

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

  // =============================
  // DOWNLOAD + RANGE SUPPORT
  // =============================

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

    const filename = encodeURIComponent(
      file.name || "download"
    );

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

        if (
          !Number.isSafeInteger(suffix) ||
          suffix <= 0
        ) {

          res.writeHead(416, {
            "Content-Range": `bytes */${size}`
          });

          return res.end();

        }

        start = Math.max(0, size - suffix);

      } else {

        start = Number(match[1]);

        end = match[2]
          ? Number(match[2])
          : size - 1;

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

      "Content-Disposition":
        `attachment; filename*=UTF-8''${filename}`,

      "Accept-Ranges": "bytes",

      "Content-Length": end - start + 1

    };

    if (statusCode === 206) {

      headers["Content-Range"] =
        `bytes ${start}-${end}/${size}`;

    }

    res.writeHead(statusCode, headers);

    if (req.method === "HEAD") {
      return res.end();
    }

    download = file.download({
      start,
      end
    });

    download.on("error", error => {

      console.error(
        "Download error:",
        error.message
      );

      if (!res.destroyed) {
        res.destroy(error);
      }

    });

    req.on("aborted", () => {

      if (download && !download.destroyed) {
        download.destroy();
      }

    });

    res.on("close", () => {

      if (
        !res.writableEnded &&
        download &&
        !download.destroyed
      ) {

        download.destroy();

      }

    });

    download.pipe(res);

  } catch (error) {

    console.error(
      "Server error:",
      error.message
    );

    if (!res.headersSent) {

      res.writeHead(500, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        success: false,
        error:
          error.message ||
          "Unable to download this MEGA file"
      }));

    } else if (!res.destroyed) {

      res.destroy(error);

    }

  }

});

// ===============================
// START SERVER
// ===============================

server.listen(PORT, "0.0.0.0", () => {

  console.log(
    `MEGADL Premium Server running on port ${PORT}`
  );

});
