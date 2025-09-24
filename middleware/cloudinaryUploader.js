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

const upload = multer({ storage });

module.exports = upload;
