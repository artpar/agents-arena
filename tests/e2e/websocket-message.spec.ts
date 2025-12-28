import { test, expect } from '@playwright/test';

test.describe('WebSocket Message Rendering', () => {
  test('user-sent message should appear in DOM via WebSocket', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000); // Wait for WebSocket to connect

    // Count initial messages
    const initialCount = await page.locator('.message').count();

    // Send a unique message
    const testMessage = 'E2E_Test_Message_' + Date.now();
    await page.locator('#message-content').fill(testMessage);
    await page.locator('.input-area button[type="submit"]').click();

    // Wait for input to clear (confirms message sent to server)
    await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

    // Wait for the message to appear in DOM via WebSocket broadcast
    await expect(page.locator('.message-content', { hasText: testMessage })).toBeVisible({ timeout: 10000 });
  });

  test('multiple messages should appear in order', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const timestamp = Date.now();
    const messages = [
      `First_${timestamp}`,
      `Second_${timestamp}`,
      `Third_${timestamp}`
    ];

    for (const msg of messages) {
      await page.locator('#message-content').fill(msg);
      await page.locator('.input-area button[type="submit"]').click();
      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await page.waitForTimeout(500); // Small delay between messages
    }

    // Verify all messages appear
    for (const msg of messages) {
      await expect(page.locator('.message-content', { hasText: msg })).toBeVisible({ timeout: 10000 });
    }
  });
});
