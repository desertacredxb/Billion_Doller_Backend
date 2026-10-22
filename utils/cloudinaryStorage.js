const { randomUUID } = require("node:crypto");
const { pipeline, Transform } = require("node:stream");
const { MulterError } = require("multer");

// Multer's documented streaming interface, using the maintained Cloudinary SDK.
// Upload IDs are server-generated so failed/aborted writes can be removed.
function createCloudinaryStorage(cloudinary, { maxBytes = 10 * 1024 * 1024 } = {}) {
  return {
    _handleFile(_req, file, callback) {
      const id = randomUUID();
      file.filename = `Billio-dollar-FX/${id}`;
      file.path = file.filename;
      let settled = false, failed = false, written = false, result, output;
      const finish = error => {
        if (settled) return;
        if (error) {
          settled = true; failed = true;
          callback(error instanceof MulterError && error.code === "LIMIT_FILE_SIZE" ? error : new Error("Document storage unavailable"));
        } else if (written && result) {
          settled = true;
          callback(null, { filename: result.public_id, path: result.secure_url, size: result.bytes });
        }
      };
      try {
        output = cloudinary.uploader.upload_stream({
          folder: "Billio-dollar-FX", public_id: id, resource_type: "image",
          allowed_formats: ["jpg", "jpeg", "png", "pdf"], timeout: 60000,
        }, (error, value) => {
          if (error || !value?.public_id || !value?.secure_url || !Number.isFinite(value?.bytes)) {
            output?.destroy();
            return finish(error || new Error("Invalid document storage response"));
          }
          if (failed) {
            // A provider response can arrive after an interrupted request.
            try { cloudinary.uploader.destroy(value.public_id, { resource_type: "image" }, error => { if (error) console.error("Document cleanup unavailable"); }); }
            catch { console.error("Document cleanup unavailable"); }
            return;
          }
          result = value; finish();
        });
        let bytes = 0;
        const bounded = new Transform({ transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > maxBytes) return done(new MulterError("LIMIT_FILE_SIZE"));
          done(null, chunk);
        } });
        pipeline(file.stream, bounded, output, error => {
          if (error) return finish(error);
          written = true; finish();
        });
      } catch (error) {
        output?.destroy(); file.stream.resume(); finish(error);
      }
    },
    _removeFile(_req, file, callback) {
      if (!file.filename) return callback(null);
      try {
        cloudinary.uploader.destroy(file.filename, { resource_type: "image" }, error => {
          if (error) return callback(new Error("Document cleanup unavailable"));
          delete file.path; delete file.filename; callback(null);
        });
      } catch { callback(new Error("Document cleanup unavailable")); }
    },
  };
}

module.exports = { createCloudinaryStorage };
