# AResources — ABooks & AVideos

Bottom nav is now **Home · Exams · AResources · Chat** (Progress is still reachable from Home).

## Student experience
- **AResources** has two sticky underline tabs: **ABooks** and **AVideos**. Each shows module cards (grid or list toggle, thumbnail optional — a module cover falls back to its first item's thumbnail, then to a coloured icon card).
- **ABooks → module**: books with an optional **subject filter** (pills) and search. Tap a book for details and "Open book".
- **AVideos → module**: sticky tabs **All | Lecturers**. *All* = every video (subject filter + search). *Lecturers* = lecturer cards → that lecturer's videos.
- Videos play in-app for YouTube, Vimeo, Google Drive and direct/uploaded MP4/WebM; any other link opens in a new tab.
- Locked modules use the existing lock system (lock badge + message).

## Admin
Admin → **AResources** (new permission "AResources (books & videos)"; owner has it automatically).
Books and videos can each use an **external link or an upload** for the file, the thumbnail and (videos) the lecturer photo. Lecturers are entered per video; reuse the same name (autocomplete helps) to group them.

## Deploy checklist
1. `firebase deploy --only firestore:rules` (adds `books`, `videos`, `resources` permission).
2. For **uploads**: enable Firebase Storage, then `firebase deploy --only storage`. NOTE: new Firebase projects may require the **Blaze** plan for Storage. On Spark, use external links (Drive / YouTube / any URL) — everything else works without Storage.
3. Deploy hosting as usual (`tools/stamp-sw.mjs` already ran, so the offline shell includes the new files).

## Data model
`books/{id}`: title, author, description, moduleId, subjectId?, sourceType (link|upload), fileUrl, thumbUrl?, order, active, universityId  
`videos/{id}`: title, description, moduleId, subjectId?, lecturer, lecturerTitle?, lecturerPhoto?, sourceType, videoUrl, thumbUrl?, duration?, order, active, universityId

Files: `menus/resources.js|css` (student), `admin/resources-admin.js` (admin), `storage.rules`.
