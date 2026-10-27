// Run: npm install && node generate-vapid.mjs
// Copy the PUBLIC key into push-config.js and keep the PRIVATE key only in Vercel.
import webpush from 'web-push';
console.log(JSON.stringify(webpush.generateVAPIDKeys(), null, 2));
