const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 400,
    show: false,
    webPreferences: { offscreen: true }
  });

  // 1. Generate LeetCode problem screenshot
  const leetcodeHtml = `
    <!DOCTYPE html>
    <html>
    <head><style>body { font-family: monospace; background: #1a1a1a; color: #fff; padding: 24px; }</style></head>
    <body>
      <h2>1. Two Sum</h2>
      <p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.</p>
      <pre>Example 1:
Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].</pre>
    </body>
    </html>
  `;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(leetcodeHtml)}`);
  await new Promise(r => setTimeout(r, 500));
  const leetcodeImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'test-leetcode.png'), leetcodeImg.toPNG());
  console.log('Generated test-leetcode.png');

  // 2. Generate Traceback screenshot
  const tracebackHtml = `
    <!DOCTYPE html>
    <html>
    <head><style>body { font-family: monospace; background: #000; color: #ff5555; padding: 24px; }</style></head>
    <body>
      <h3>Exception in thread "main" java.lang.NullPointerException: Cannot invoke "User.getName()" because "user" is null</h3>
      <p style="color: #ccc;">at com.example.service.OrderService.processUser(OrderService.java:42)</p>
      <p style="color: #ccc;">at com.example.service.OrderService.checkout(OrderService.java:18)</p>
      <p style="color: #ccc;">at com.example.App.main(App.java:10)</p>
    </body>
    </html>
  `;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tracebackHtml)}`);
  await new Promise(r => setTimeout(r, 500));
  const tracebackImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'test-traceback.png'), tracebackImg.toPNG());
  console.log('Generated test-traceback.png');

  win.destroy();
  app.quit();
});
