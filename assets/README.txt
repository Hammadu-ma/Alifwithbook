LOGIN PAGE ASSETS
-----------------
logo.png            -> put your logo in the project ROOT (next to index.html). It shows in the logo tile.
assets/login-dark.jpg  -> background photo for DARK mode  (recommended 1920x1080+, keep under ~400 KB)
assets/login-light.jpg -> background photo for LIGHT mode (recommended 1920x1080+, keep under ~400 KB)

If a photo file is missing, the built-in medical artwork (DNA helix + heartbeat line) is shown instead.
Batch list: edit the <option> years inside <select id="authSignupBatch"> in index.html.

Login background photos are optional. After adding assets/login-dark.jpg and assets/login-light.jpg, add the attribute
data-login-photos to the <html> tag in index.html (it is off by default so a missing file does not cause 404 requests).
