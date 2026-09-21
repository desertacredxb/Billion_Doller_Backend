// middleware/cloudinaryUploader.js
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../utils/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "Billio-dollar-FX",
    allowed_formats: ["jpg", "jpeg", "png", "pdf"],
  },
});

const MAX_FILE_SIZE_MB = 10;
const SUPPORTED_FORMATS_LABEL = "JPG, JPEG, PNG, or PDF";

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

// Wraps upload.fields() so a rejected file (wrong format, too large, or a
// Cloudinary-side failure) reaches the client as a clear, actionable message
// instead of falling through to Express's default HTML error page.
function uploadKycDocuments(fields) {
  const middleware = upload.fields(fields);

  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: `That file is larger than ${MAX_FILE_SIZE_MB}MB. Please upload a ${SUPPORTED_FORMATS_LABEL} file up to ${MAX_FILE_SIZE_MB}MB.`,
        });
      }

      console.error("Document upload failed:", err);
      return res.status(400).json({
        success: false,
        message: `We couldn't upload that file. Please make sure it's a ${SUPPORTED_FORMATS_LABEL} file up to ${MAX_FILE_SIZE_MB}MB.`,
      });
    });
  };
}

module.exports = upload;
module.exports.uploadKycDocuments = uploadKycDocuments;
module.exports.MAX_FILE_SIZE_MB = MAX_FILE_SIZE_MB;
module.exports.SUPPORTED_FORMATS_LABEL = SUPPORTED_FORMATS_LABEL;
