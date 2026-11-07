# Cloudflare R2 storage (books, notes, PDF exams, videos)

Uploads from **Admin → AResources** now go to a Cloudflare R2 bucket instead of Firebase Storage
(Firebase Storage needs the Blaze plan, R2 does not). Files are private: the app stores
`/api/r2?key=books/<file>` and the server answers with a short-lived signed R2 link.

## 1. Vercel environment variables (main app project)
| Name | Value |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 S3 **Access Key ID** |
| `R2_SECRET_ACCESS_KEY` | R2 S3 **Secret Access Key** |
| `R2_BUCKET` | bucket name, e.g. `abooks` |
| `FIREBASE_WEB_API_KEY` | already set (used by the receipt relay) |

Redeploy after changing them.

## 2. Bucket CORS (R2 → bucket → Settings → CORS policy)
```json
[
  {
    "AllowedOrigins": ["https://alifwithbook.vercel.app", "https://alifmed.com", "https://alifmeta.vercel.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```
`PUT` lets the admin page upload straight to R2, `GET` lets the in-app PDF reader draw files.

## 3. Use
Admin → AResources → add a book → *Upload* → choose where to save it (**Books / Notes / PDF exams**).
Videos go to `videos/`, thumbnails to `thumbs/`. Links (Drive, YouTube…) still work as before.
Only admins with the *AResources* permission (or owners) can upload or delete; anyone with the app can open a file.

## Security notes
* The Access Key / Secret never reach the browser; rotate them in Cloudflare any time and update the Vercel variables.
* Object names contain a random prefix, so file links cannot be guessed.
