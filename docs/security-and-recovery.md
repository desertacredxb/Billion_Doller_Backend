# Security updates and recovery — 22 October 2026

## Dependency changes

The initial backend audit reported 21 vulnerable package entries (one critical). The updated backend dependency graph reports zero known npm audit findings. Axios, Express, Multer, Cloudinary and Nodemailer use patched releases; Mongoose stays on its existing major version. The runtime is bounded to Node 22.x. The deprecated crypto package is removed in favor of Node's existing built-in module resolution. Development watching uses Node's built-in watch mode, removing the vulnerable nodemon/globbing dependency chain.

The old multer-storage-cloudinary adapter required vulnerable Cloudinary 1.x. A small streaming Multer storage engine now uses the maintained Cloudinary SDK directly. It preserves the existing folder, supported JPG/JPEG/PNG/PDF formats, returned file metadata and ten-megabyte limit. Server-generated object IDs permit interrupted/failed upload cleanup; an additional bounded stream prevents forwarding oversized content. Raw provider errors are redacted. Synthetic HTTP upload, size-limit, cleanup, interrupted-stream and email-composition tests exercise the changed integrations without uploading identity documents or sending email.

The website initially had 29 vulnerable package entries (two critical). It is updated to patched Next.js 16, React 19 and Axios releases. The typography dependency uses a patched PostCSS selector parser through a scoped override. The remaining upstream braces advisory (GHSA-vfj7-8cjw-p6xm, no patched release at verification) is in the development-only Next.js ESLint/globbing chain. Do not claim a completely clean frontend audit while these lint entries remain. Production audit and critical-advisory checks are separate CI gates; the warning is not hidden or replaced by a fake version.

Both repositories have Node 22 checks using pinned GitHub Actions, lockfile installs, existing tests and dependency audits. Website CI also builds the production application. Passing npm audit means no currently reported dependency advisories within that audit's scope, not proof that all application security risks are eliminated.

## Failure alerts

The backend/public-site monitor is scheduled at minutes 7, 22, 37 and 52 UTC of every hour. It reads public endpoints, verifies database readiness and expected website content, assigns one bot-owned incident issue to the repository owner desertacredxb, updates that incident while unhealthy and closes only its own marked issue on recovery. GitHub scheduling is best-effort, not a guaranteed 15-minute detection SLA. The repository is public; no paid monitoring service is created.

The existing Render HTTP health path and inherited Only failure notifications setting are preserved. An additional hourly ChatGPT condition watch reads this repository's production-health workflow/incident status and notifies the owner for new incidents, material worsening or recovery. It does not send customer messages or perform remediation automatically. Creation/enabling of the watch is verified; actual future push/email delivery must not be inferred from that configuration alone. GitHub email delivery depends on the recipient's notification settings.

## Production backup blocker

Fresh MongoDB connector discovery shows Sandeep's Org - 2026-10-20, Project 0 (6ad7f5e9d7869265e2a7db73), with zero clusters. This is not the existing BDFX production deployment. The public backend/database health is a separate signal; an empty accessible project is not evidence that production data is absent or unhealthy.

No production backup, snapshot, export, restore, cluster replacement or paid upgrade has been created. Completion requires access to the existing production database's actual organization/project. Do not request a database password or connection URI in chat. Use the correct connected provider account and project or the owner's own Atlas interface. Inspect the actual tier, supported backup features, recent snapshots, retention and alert destinations before proposing any paid change.

Once available, configure a suitable recurring backup policy in the existing provider, confirm a successful recoverable snapshot and test restoration into an isolated destination. Verify collection counts, required unique indexes and non-sensitive integrity checks; record recovery point and elapsed restore time. Never restore over production or point the live application at the restore target. Provider backup failure/staleness alerts also remain to be verified with that actual project.

References:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://www.mongodb.com/docs/atlas/backup/cloud-backup/overview/
- https://cloudinary.com/documentation/node_image_and_video_upload
- https://github.com/expressjs/multer/blob/main/StorageEngine.md
