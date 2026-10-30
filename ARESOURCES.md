# AResources — ABooks & AVideos

Bottom nav is now **Home · Exams · AResources · Chat** (Progress is still reachable from Home).

## Student experience
- **AResources** has two sticky underline tabs: **ABooks** and **AVideos**. Each shows module cards (grid or list toggle, thumbnail optional — a module cover falls back to its first item's thumbnail, then to a coloured icon card).
- **ABooks → module**: books with an optional **subject filter** (pills) and search. Tap a book for details and "Open book".
- **AVideos → module**: sticky tabs **All | Lecturers**. *All* = every video (subject filter + search). *Lecturers* = lecturer cards → that lecturer's videos.
- **Everything opens inside the app — nothing opens a new tab.**
  - Books: PDFs (uploaded or direct links) are rendered page-by-page in the built-in reader with zoom and a page counter (pdf.js, loaded from cdnjs). Google Drive files and Word/PowerPoint/Excel files open in an embedded viewer. EPUB isn't supported yet.
  - Videos: YouTube, Vimeo, Google Drive and direct/uploaded MP4/WebM play in the built-in player. Unknown sites are embedded in the player; a few refuse to be embedded.
  - If a PDF host blocks in-app reading (CORS), the reader automatically falls back to the embedded viewer.
- Locked modules use the existing lock system (lock badge + message).

## Admin
Admin → **AResources** (new permission "AResources (books & videos)"; owner has it automatically).
Books and videos can each use an **external link or an upload** for the file, the thumbnail and (videos) the lecturer photo. Lecturers are entered per video; reuse the same name (autocomplete helps) to group them.

## The reader
Immersive full-screen reader for PDFs (and a compact version under videos):
- **Themes** Paper / Sepia / Night, **Scroll** or **Pages** layout (swipe, tap the edges, arrow keys), zoom, jump-to-page, page slider.
- **Contents** from the PDF outline, **bookmarks**, **full-text search** with highlighted snippets.
- Resumes at the page you stopped on, remembers theme/layout, keeps the screen awake, toolbars hide while you read.
- **Nothing can leave the app**: no links anywhere, link clicks are swallowed, and every embedded viewer/video frame is sandboxed without pop-ups or top-level navigation.
- Word/PowerPoint/Excel and Google Drive files open in a sandboxed embedded viewer (less featureful). For the full reader experience, **upload PDFs or use a direct PDF link whose server allows CORS**; otherwise the reader falls back to the embedded viewer.

## Deploy checklist
1. `firebase deploy --only firestore:rules` (adds `books`, `videos`, `resources` permission).
2. For **uploads**: enable Firebase Storage, then `firebase deploy --only storage`. NOTE: new Firebase projects may require the **Blaze** plan for Storage. On Spark, use external links (Drive / YouTube / any URL) — everything else works without Storage.
3. **Uploaded PDFs need CORS** so the reader can draw them natively: `gsutil cors set cors.json gs://YOUR_BUCKET` (file `cors.json` is included; replace `*` with your site's origin if you prefer).
4. Deploy hosting as usual (`tools/stamp-sw.mjs` already ran, so the offline shell includes the new files).

## Data model
`books/{id}`: title, author, description, moduleId, subjectId?, sourceType (link|upload), fileUrl, thumbUrl?, order, active, universityId  
`videos/{id}`: title, description, moduleId, subjectId?, lecturer, lecturerTitle?, lecturerPhoto?, sourceType, videoUrl, thumbUrl?, duration?, order, active, universityId

Files: `menus/resources.js|css` (student), `admin/resources-admin.js` (admin), `storage.rules`.

## Video player, related content and inline quizzes
- **Own player controls** (themed progress bar, play/pause, ±10s, volume, speed 0.75–2×, fullscreen, double-tap to skip on touch, keyboard shortcuts). They sit over uploaded/direct MP4-WebM, **YouTube** (IFrame API) and **Vimeo** (Player API) videos, with the native controls hidden. Google Drive and unknown sites expose no player API, so they use a plain embed.
- **Under the video**: tabs **Videos · Books · Quizzes**. A book (PDF reader) or a quiz opens right there in the panel while the video keeps playing. Choosing a related video switches the player.
- **Admin links** (Admin → AResources → add/edit):
  - Video form → *Related content*: related videos, related books, related quizzes.
  - Book form → *Link to videos*: the book also shows under those videos.
  - Quiz links: a **specific quiz** (e.g. a year's paper), **every quiz of a subject**, **every quiz of a module**, or a **question category** (mixed practice from that subject's quizzes).
  - If no related videos are linked, the app suggests videos from the same subject/module.
- **Resizable**: a grip handle between the video and the tabs/panel can be dragged (up/down on phones, left/right on desktop) or moved with arrow keys; double-tap/click resets it. The size is remembered. Books and quizzes in the panel adapt, and the video keeps playing.
- **Quizzes use the app's real quiz screen**, embedded under the video without its sidebar (no second quiz implementation). A slim bar gives search, categories, bookmarks, submit and **Open in full-screen quiz** (hands the same running quiz to the normal quiz screen). Progress, bookmarks and results are saved exactly as for a quiz started from Exams, and quiz locks are respected.
- *Question category* links have no real quiz behind them, so they use a small built-in practice runner (instant feedback, score, retry mistakes) that does not record results.
- Data: `videos.related = { videos:[id], books:[id], quizzes:[{type:'quiz'|'subject'|'module'|'category', ...}] }`, `books.linkedVideoIds:[id]`.
