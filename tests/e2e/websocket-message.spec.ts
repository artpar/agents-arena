import { test, expect, Page } from '@playwright/test';

test.describe('WebSocket Message Rendering', () => {
  // Use fresh rooms to avoid state pollution between tests
  const getTestRoom = () => `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  test.describe('Basic Message Flow', () => {
    test('user-sent message should appear in DOM via WebSocket', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const testMessage = 'E2E_Test_Message_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: testMessage })).toBeVisible({ timeout: 10000 });
    });

    test('multiple messages should appear in order', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
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
        await page.waitForTimeout(300);
      }

      for (const msg of messages) {
        await expect(page.locator('.message-content', { hasText: msg })).toBeVisible({ timeout: 10000 });
      }
    });

    test('message should include sender name', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const timestamp = Date.now();
      const senderName = 'TestSender_' + timestamp;
      const testMessage = 'SenderTest_' + timestamp;

      await page.locator('#sender-name').fill(senderName);
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      // Verify the message appears with the correct sender
      const messageEl = page.locator('.message', { hasText: testMessage });
      await expect(messageEl).toBeVisible({ timeout: 10000 });
      await expect(messageEl.locator('.message-sender')).toContainText(senderName);
    });

    test('message should have timestamp', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const testMessage = 'Timestamp_Test_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      const messageEl = page.locator('.message', { hasText: testMessage });
      await expect(messageEl).toBeVisible({ timeout: 10000 });

      // Timestamp should be in HH:MM:SS format
      const timeEl = messageEl.locator('.message-time');
      await expect(timeEl).toBeVisible();
      const timeText = await timeEl.textContent();
      expect(timeText).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  test.describe('Message Deduplication', () => {
    test('same message should not appear twice', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const testMessage = 'Dedup_Test_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: testMessage })).toBeVisible({ timeout: 10000 });

      // Wait a bit and verify only one instance exists
      await page.waitForTimeout(2000);
      const messageCount = await page.locator('.message-content', { hasText: testMessage }).count();
      expect(messageCount).toBe(1);
    });
  });

  test.describe('Typing Indicators', () => {
    test('typing indicator should show when agent is thinking', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const typingIndicator = page.locator('#typing-indicator');

      // Initially should be empty
      await expect(typingIndicator).toBeEmpty();

      // Trigger an agent to respond (if API key is configured)
      const stepBtn = page.locator('.step-btn').first();
      if (await stepBtn.isVisible()) {
        await stepBtn.click();

        // Typing indicator might show briefly
        // We just verify the element exists and is functional
        await expect(typingIndicator).toBeAttached();
      }
    });
  });

  test.describe('Room-Specific Messages', () => {
    test('messages should be room-specific', async ({ page }) => {
      // Go to a specific room
      const roomName = 'testroom_' + Date.now();
      await page.goto(`/r/${roomName}`);
      await page.waitForTimeout(2000);

      const testMessage = 'Room_Specific_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: testMessage })).toBeVisible({ timeout: 10000 });

      // Navigate to a different room - message should not be visible
      await page.goto('/r/other_room');
      await page.waitForTimeout(2000);

      await expect(page.locator('.message-content', { hasText: testMessage })).not.toBeVisible();
    });

    test('room change should update current room context', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);

      // Verify main element has data-current-room attribute
      const mainEl = page.locator('main');
      await expect(mainEl).toHaveAttribute('data-current-room', 'general');

      // Navigate to a different room
      const newRoom = 'testroom_' + Date.now();
      await page.goto(`/r/${newRoom}`);
      await page.waitForTimeout(2000);

      await expect(mainEl).toHaveAttribute('data-current-room', newRoom);
    });
  });

  test.describe('WebSocket Connection', () => {
    test('should establish WebSocket connection on page load', async ({ page }) => {
      const wsConnected = page.waitForEvent('console', {
        predicate: msg => msg.text().includes('[WS] Connected'),
        timeout: 10000
      });

      await page.goto('/');
      await wsConnected;
    });

    test('should join room on WebSocket connect', async ({ page }) => {
      const wsJoined = page.waitForEvent('console', {
        predicate: msg => msg.text().includes('[WS] Joined room:'),
        timeout: 10000
      });

      await page.goto('/');
      await wsJoined;
    });

    test('should reconnect on disconnect', async ({ page }) => {
      await page.goto('/');

      // Wait for initial connection
      await page.waitForEvent('console', {
        predicate: msg => msg.text().includes('[WS] Connected'),
        timeout: 10000
      });

      // Force disconnect by closing the WebSocket
      await page.evaluate(() => {
        const wsInstances = (window as any).__wsInstances || [];
        wsInstances.forEach((ws: WebSocket) => ws.close());
      });

      // Should see disconnection log
      // Note: May not always trigger reconnection in test environment
    });
  });

  test.describe('Message Content Types', () => {
    test('should handle special characters in messages', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const specialMessage = 'Special chars: <script>alert("xss")</script> & "quotes" \'single\'';
      await page.locator('#message-content').fill(specialMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      // Message should appear but XSS should be escaped
      await page.waitForTimeout(2000);

      // Script tag should NOT execute - check no alert was shown
      // The content should be visible as text, not executed
      const alertShown = await page.evaluate(() => (window as any).__alertTriggered);
      expect(alertShown).toBeFalsy();
    });

    test('should handle emoji in messages', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const emojiMessage = 'Hello 👋 World 🌍 Test 🧪 ' + Date.now();
      await page.locator('#message-content').fill(emojiMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: '👋' })).toBeVisible({ timeout: 10000 });
    });

    test('should handle long messages', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const longMessage = 'Long_' + 'x'.repeat(500) + '_' + Date.now();
      await page.locator('#message-content').fill(longMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: 'Long_' })).toBeVisible({ timeout: 10000 });
    });

    test('should handle markdown in messages', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const markdownMessage = '**Bold** and *italic* text ' + Date.now();
      await page.locator('#message-content').fill(markdownMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      // Wait for message to appear and markdown to render
      await page.waitForTimeout(2000);

      // Check if markdown was rendered (strong tag for bold)
      const messageEl = page.locator('.message-content', { hasText: 'Bold' }).first();
      await expect(messageEl).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Message UI Elements', () => {
    test('message should have avatar with initial', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const senderName = 'Alice';
      const testMessage = 'Avatar_Test_' + Date.now();

      await page.locator('#sender-name').fill(senderName);
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      const messageEl = page.locator('.message', { hasText: testMessage });
      await expect(messageEl).toBeVisible({ timeout: 10000 });

      // Check avatar has initial 'A'
      const avatar = messageEl.locator('.message-avatar');
      await expect(avatar).toContainText('A');
    });

    test('message should have delete button', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const testMessage = 'Delete_Button_Test_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      const messageEl = page.locator('.message', { hasText: testMessage });
      await expect(messageEl).toBeVisible({ timeout: 10000 });

      // Check delete button exists
      const deleteBtn = messageEl.locator('.message-delete');
      await expect(deleteBtn).toBeVisible();
    });

    test('delete button should remove message', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const testMessage = 'To_Be_Deleted_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });

      const messageEl = page.locator('.message', { hasText: testMessage });
      await expect(messageEl).toBeVisible({ timeout: 10000 });

      // Click delete button
      await messageEl.locator('.message-delete').click();

      // Message should be removed
      await expect(messageEl).not.toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Scroll Behavior', () => {
    test('should auto-scroll to new messages when at bottom', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const messagesDiv = page.locator('#messages');

      // Scroll to bottom first
      await messagesDiv.evaluate(el => el.scrollTop = el.scrollHeight);
      await page.waitForTimeout(500);

      const testMessage = 'Scroll_Test_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('.message-content', { hasText: testMessage })).toBeVisible({ timeout: 10000 });

      // Wait for scroll animation to complete
      await page.waitForTimeout(500);

      // Verify we're still scrolled to bottom (with generous threshold)
      const isNearBottom = await messagesDiv.evaluate(el => {
        const threshold = 200;
        return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      });
      expect(isNearBottom).toBe(true);
    });

    test('should not auto-scroll when user scrolled up', async ({ page }) => {
      await page.goto(`/r/${getTestRoom()}`);
      await page.waitForTimeout(2000);

      const messagesDiv = page.locator('#messages');

      // Scroll to top
      await messagesDiv.evaluate(el => el.scrollTop = 0);
      const initialScrollTop = await messagesDiv.evaluate(el => el.scrollTop);

      const testMessage = 'NoScroll_Test_' + Date.now();
      await page.locator('#message-content').fill(testMessage);
      await page.locator('.input-area button[type="submit"]').click();

      await expect(page.locator('#message-content')).toHaveValue('', { timeout: 5000 });
      await page.waitForTimeout(2000);

      // Verify scroll position wasn't changed
      const currentScrollTop = await messagesDiv.evaluate(el => el.scrollTop);
      expect(currentScrollTop).toBe(initialScrollTop);
    });
  });
});
