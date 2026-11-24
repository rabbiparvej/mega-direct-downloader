
const { File } = require("megajs");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const url = req.body?.url;
    const parsed = new URL(url);

    if (
      !["mega.nz", "www.mega.nz", "mega.co.nz"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith("/file/")
    ) {
      return res.status(400).json({ error: "Invalid MEGA link" });
    }

    const file = File.fromURL(url);
    await file.loadAttributes();

    return res.status(200).json({
      success: true,
      name: file.name,
      size: file.size,
      sizeMB: (file.size / 1048576).toFixed(2)
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
};
