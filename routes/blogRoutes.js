const express = require("express");
const multer = require("multer");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const cloudinary = require("../utils/cloudinary");
const controller = require("../controllers/blogController").createController();
const router = express.Router();
const admin = [auth, access.principal, access.admin];
const optionalAdmin = (req, res, next) => req.headers.authorization ? auth(req, res, () => access.principal(req, res, next)) : next();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) });
router.get("/", (req, res, next) => req.query.status === "published" ? next() : auth(req, res, () => access.principal(req, res, () => access.admin(req, res, next))), controller.list);
router.get("/slug/:slug", controller.slug);
router.post("/", ...admin, express.json({ limit: "350kb" }), controller.create);
router.post("/upload", ...admin, (req, res, next) => upload.single("file")(req, res, async error => {
  if (error || !req.file) return res.status(400).json({ success: false, error: "Choose a JPEG, PNG, WebP or GIF image up to 5 MB." });
  if (!["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"].every(key => process.env[key])) return res.status(503).json({ success: false, error: "Image uploads are not configured. Contact the website administrator." });
  try {
    const result = await new Promise((resolve, reject) => cloudinary.uploader.upload_stream({ folder: "blog_assets", resource_type: "image", allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"] }, (err, data) => err ? reject(err) : resolve(data)).end(req.file.buffer));
    res.json({ success: true, url: result.secure_url });
  } catch (err) { next(err); }
}));
router.get("/:id", optionalAdmin, controller.get);
router.put("/:id", ...admin, express.json({ limit: "350kb" }), controller.update);
router.patch("/:id", ...admin, express.json({ limit: "350kb" }), controller.update);
router.delete("/:id", ...admin, controller.remove);
module.exports = router;
