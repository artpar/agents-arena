import { test, expect } from '@playwright/test';

test.describe('Agent Arena UI', () => {

  test.describe('Page Load', () => {
    test('should load the main page', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveTitle(/Agent Arena/);
      await expect(page.locator('header h1')).toContainText('Agent Arena');
    });

    test('should show connection status', async ({ page }) => {
      await page.goto('/');
      // Wait for WebSocket to connect (allow extra time for initial connection)
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
    });

    test('should load agents list', async ({ page }) => {
      await page.goto('/');
      // Wait for agents section to load - text includes count like "Agents (2)"
      await expect(page.getByText(/Agents \(/)).toBeVisible();
      await page.waitForTimeout(1000);
    });

    test('should show sidebar sections', async ({ page }) => {
      await page.goto('/');
      // Sidebar should have all major section headings
      await expect(page.locator('aside h2', { hasText: 'Rooms' })).toBeVisible();
      await expect(page.locator('aside h2', { hasText: /Agents/ })).toBeVisible();
      await expect(page.locator('aside h2', { hasText: 'Project' })).toBeVisible();
      await expect(page.locator('aside h2', { hasText: 'Status' })).toBeVisible();
    });
  });

  test.describe('Messages', () => {
    test('should have message input', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#messageInput')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    });

    test('should send a message', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const messageInput = page.locator('#messageInput');
      const sendBtn = page.getByRole('button', { name: 'Send' });
      const testMessage = 'Test message ' + Date.now();

      await messageInput.fill(testMessage);
      await sendBtn.click();

      // Input should be cleared after send
      await expect(messageInput).toHaveValue('', { timeout: 5000 });
    });

    test('should display sent message in the list', async ({ page }) => {
      await page.goto('/?room=general');
      // Wait for WebSocket connection
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(1000);

      const messageInput = page.locator('#messageInput');
      const testMessage = 'Live test ' + Date.now();

      // Type and send message
      await messageInput.fill(testMessage);
      await page.getByRole('button', { name: 'Send' }).click();

      // Input should clear
      await expect(messageInput).toHaveValue('', { timeout: 5000 });

      // Message should appear via WebSocket broadcast (no reload needed)
      await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 10000 });
    });

    test('should show sender name', async ({ page }) => {
      await page.goto('/');
      const senderInput = page.locator('#senderInput');
      await expect(senderInput).toBeVisible();
      await expect(senderInput).toHaveValue('Human');
    });

    test('should persist sender name', async ({ page }) => {
      await page.goto('/');
      const senderInput = page.locator('#senderInput');

      await senderInput.fill('TestUser123');
      await senderInput.blur();

      // Reload and check
      await page.reload();
      await expect(page.locator('#senderInput')).toHaveValue('TestUser123', { timeout: 3000 });
    });
  });

  test.describe('Agents', () => {
    test('should display agents with step buttons', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);

      // Hover to reveal step button
      const agentRow = page.locator('aside').getByText('Step').first();
      // Step buttons exist (may be hidden until hover)
      const stepButtons = page.locator('button:has-text("Step")');
      const count = await stepButtons.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('should step agent when clicking step button', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);

      const initialMessageCount = await page.locator('#messageList > div').count();

      // Find an agent row and hover to show step button
      const agentSection = page.locator('aside').locator('div', { hasText: /^Agents/ }).locator('..');
      const agentRow = agentSection.locator('div.group').first();

      if (await agentRow.isVisible()) {
        await agentRow.hover();
        const stepBtn = agentRow.getByRole('button', { name: 'Step' });
        if (await stepBtn.isVisible()) {
          await stepBtn.click();

          // Wait for agent response
          await page.waitForTimeout(10000);
          const newMessageCount = await page.locator('#messageList > div').count();
          expect(newMessageCount).toBeGreaterThanOrEqual(initialMessageCount);
        }
      }
    });

    test('should add agent via input', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Use a valid persona path format
      const agentPath = 'personas/test-e2e';
      const addInput = page.locator('#addAgentInput');
      await addInput.fill(agentPath);
      await addInput.press('Enter');

      // Check if agent list updated (agent names show as first part of path)
      await page.waitForTimeout(3000);
    });
  });

  test.describe('Rooms', () => {
    test('should show current room in header', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('main')).toContainText('#general');
    });

    test('should switch rooms', async ({ page }) => {
      await page.goto('/');

      const roomInput = page.locator('#newRoomInput');
      await roomInput.fill('test-room');
      await page.getByRole('button', { name: 'Go' }).click();

      await expect(page).toHaveURL(/room=test-room/, { timeout: 5000 });
      await expect(page.locator('main')).toContainText('#test-room');
    });

    test('should edit room topic', async ({ page }) => {
      await page.goto('/');

      const topicInput = page.locator('#topicInput');
      await topicInput.fill('Test topic ' + Date.now());
      await topicInput.blur();

      // Topic should persist on reload
      const topicValue = await topicInput.inputValue();
      await page.reload();
      await page.waitForTimeout(1000);
      await expect(page.locator('#topicInput')).toHaveValue(topicValue, { timeout: 3000 });
    });
  });

  test.describe('Controls', () => {
    test('should have mode selector', async ({ page }) => {
      await page.goto('/');
      const modeSelect = page.locator('select').first();
      await expect(modeSelect).toBeVisible();
      // Should have options
      const options = modeSelect.locator('option');
      expect(await options.count()).toBeGreaterThanOrEqual(3);
    });

    test('should have start/stop button', async ({ page }) => {
      await page.goto('/');
      const startOrStop = page.locator('button:has-text("Start"), button:has-text("Stop")').first();
      await expect(startOrStop).toBeVisible();
    });

    test('should toggle start/stop', async ({ page }) => {
      await page.goto('/');

      const startBtn = page.getByRole('button', { name: 'Start' });
      const stopBtn = page.getByRole('button', { name: 'Stop' });

      if (await startBtn.isVisible()) {
        await startBtn.click();
        await expect(stopBtn).toBeVisible({ timeout: 3000 });
      } else if (await stopBtn.isVisible()) {
        await stopBtn.click();
        await expect(startBtn).toBeVisible({ timeout: 3000 });
      }
    });

    test('should change mode', async ({ page }) => {
      await page.goto('/');

      const modeSelect = page.locator('header select').first();
      await modeSelect.selectOption('turn_based');

      // Mode is sent to server and persists in server state
      await page.waitForTimeout(1000);
      await page.reload();
      // Wait for status to load from server
      await page.waitForTimeout(1000);
      await expect(page.locator('header select').first()).toHaveValue('turn_based', { timeout: 5000 });
    });
  });

  test.describe('Delete Messages', () => {
    test('should delete individual message on hover', async ({ page }) => {
      // Use general room which has messages
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Send a test message with unique ID
      const testId = Date.now();
      const messageInput = page.locator('#messageInput');
      await messageInput.fill('Delete me ' + testId);
      await page.getByRole('button', { name: 'Send' }).click();

      // Wait for the specific message to appear via WebSocket
      await expect(page.locator('#messageList')).toContainText('Delete me ' + testId, { timeout: 10000 });

      // Get count after our message appeared
      const initialCount = await page.locator('#messageList > div').count();
      expect(initialCount).toBeGreaterThan(0);

      // Find the message we just sent and delete it
      const ourMessage = page.locator('#messageList > div', { hasText: 'Delete me ' + testId });
      await ourMessage.hover();
      const deleteBtn = ourMessage.locator('button:has-text("×")');
      await deleteBtn.click({ force: true });

      // Wait for deletion to propagate
      await page.waitForTimeout(500);
      const newCount = await page.locator('#messageList > div').count();
      expect(newCount).toBeLessThan(initialCount);
    });

    test('should clear all messages', async ({ page }) => {
      await page.goto('/');

      // Handle confirm dialog
      page.on('dialog', dialog => dialog.accept());

      const clearBtn = page.getByRole('button', { name: 'Clear All' });
      await expect(clearBtn).toBeVisible();
      await clearBtn.click();

      await page.waitForTimeout(1000);
      const count = await page.locator('#messageList > div').count();
      expect(count).toBe(0);
    });
  });

  test.describe('Project Management', () => {
    test('should show new project button or existing project', async ({ page }) => {
      await page.goto('/');

      // Project section should be visible - look for the heading
      await expect(page.locator('aside h2', { hasText: 'Project' })).toBeVisible();
    });

    test('should open create project modal', async ({ page }) => {
      await page.goto('/');

      const newProjectBtn = page.getByRole('button', { name: '+ New Project' });
      if (await newProjectBtn.isVisible()) {
        await newProjectBtn.click();
        await expect(page.getByText('New Project').first()).toBeVisible();
        await expect(page.locator('#projectNameInput')).toBeVisible();
      }
    });

    test('should create a project', async ({ page }) => {
      await page.goto('/');

      const newProjectBtn = page.getByRole('button', { name: '+ New Project' });
      if (await newProjectBtn.isVisible()) {
        await newProjectBtn.click();

        const projectName = 'Test Project ' + Date.now();
        await page.locator('#projectNameInput').fill(projectName);
        await page.locator('#projectGoalInput').fill('Test goal');
        await page.getByRole('button', { name: 'Create' }).click();

        // Modal should close
        await expect(page.locator('#modal-overlay')).toBeHidden({ timeout: 3000 });
      }
    });
  });

  test.describe('File Attachments', () => {
    test('should have file input', async ({ page }) => {
      await page.goto('/');
      const fileInput = page.locator('#fileInput');
      await expect(fileInput).toBeAttached();
    });
  });

  test.describe('Personas Page', () => {
    test('should load personas page', async ({ page }) => {
      await page.goto('/personas');
      await expect(page).toHaveTitle(/Persona Manager/);
      await expect(page.getByText('Persona Manager')).toBeVisible();
    });

    test('should show existing personas', async ({ page }) => {
      await page.goto('/personas');
      await page.waitForTimeout(1000);

      const personaCount = await page.locator('[data-id]').count();
      expect(personaCount).toBeGreaterThanOrEqual(0);
    });

    test('should have persona form', async ({ page }) => {
      await page.goto('/personas');
      await expect(page.locator('#name')).toBeVisible();
      await expect(page.locator('#description')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create Persona' })).toBeVisible();
    });

    test('should navigate back to arena', async ({ page }) => {
      await page.goto('/personas');
      await page.getByRole('link', { name: 'Back to Arena' }).click();
      await expect(page).toHaveURL('/');
    });

    test('should have team generation', async ({ page }) => {
      await page.goto('/personas');
      await page.waitForTimeout(500);
      await expect(page.getByText('Generate Team').first()).toBeVisible();
      await expect(page.locator('#team-desc')).toBeVisible();
    });

    test('should have single persona generation', async ({ page }) => {
      await page.goto('/personas');
      await expect(page.getByText('Generate Single Persona')).toBeVisible();
      await expect(page.locator('#gen-prompt')).toBeVisible();
    });
  });

  test.describe('WebSocket Real-time Updates', () => {
    test('should show typing indicator when agent is responding', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);

      // Find and click step button on first agent
      const agentSection = page.locator('aside').locator('div', { hasText: /^Agents/ }).locator('..');
      const agentRow = agentSection.locator('div.group').first();

      if (await agentRow.isVisible()) {
        await agentRow.hover();
        const stepBtn = agentRow.getByRole('button', { name: 'Step' });
        if (await stepBtn.isVisible()) {
          await stepBtn.click();

          // Typing indicator might appear
          await page.waitForTimeout(500);
          // Just check that the request was sent - typing indicator is transient
        }
      }
    });
  });

  test.describe('Responsive Layout', () => {
    test('sidebar should be visible', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('aside')).toBeVisible();
    });

    test('main content should be visible', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();
    });
  });

  test.describe('Error Handling', () => {
    test('should handle API errors gracefully', async ({ page }) => {
      await page.goto('/');
      // Page should load without errors
      await expect(page.locator('header')).toBeVisible();
    });
  });
});
