import { test, expect } from '@playwright/test';

test.describe('Agent Arena UI', () => {

  test.describe('Page Load', () => {
    test('should load the main page', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveTitle(/Agent Arena/);
      await expect(page.locator('header h1')).toContainText('Agent Arena');
    });

    test('should establish WebSocket connection', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Verify connection is functional by checking agents load
      await expect(page.getByText(/Agents \(\d+\)/)).toBeVisible({ timeout: 5000 });
    });

    test('should load agents from server', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Verify actual agents are loaded (not just the section header)
      const agentCount = await page.locator('aside button:has-text("Step")').count();
      expect(agentCount).toBeGreaterThan(0);
    });
  });

  test.describe('Messages', () => {
    test('should send message and display it via WebSocket', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      const testMessage = 'Behavior test ' + Date.now();
      const messageInput = page.locator('#messageInput');

      await messageInput.fill(testMessage);
      await page.getByRole('button', { name: 'Send' }).click();

      // Verify: input cleared AND message appears in list
      await expect(messageInput).toHaveValue('', { timeout: 5000 });
      await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 10000 });
    });

    test('should persist sender name across sessions', async ({ page }) => {
      const uniqueName = 'TestUser' + Date.now();

      await page.goto('/');
      await page.locator('#senderInput').fill(uniqueName);
      await page.locator('#senderInput').blur();

      // Send a message with this sender name
      await page.locator('#messageInput').fill('Test from ' + uniqueName);
      await page.getByRole('button', { name: 'Send' }).click();

      // Reload and verify sender name persisted
      await page.reload();
      await expect(page.locator('#senderInput')).toHaveValue(uniqueName, { timeout: 5000 });
    });
  });

  test.describe('Agents', () => {
    test('should step agent and receive response message', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(1000);

      const initialMessageCount = await page.locator('#messageList > div').count();

      // Find and click step button
      const agentRow = page.locator('aside div.group').first();
      await agentRow.hover();
      const stepBtn = agentRow.getByRole('button', { name: 'Step' });

      if (await stepBtn.isVisible()) {
        await stepBtn.click();

        // Verify: agent actually responds with a new message
        await expect(async () => {
          const newCount = await page.locator('#messageList > div').count();
          expect(newCount).toBeGreaterThan(initialMessageCount);
        }).toPass({ timeout: 30000 });
      }
    });

    test('should show agent add input', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Verify add agent input exists
      const addInput = page.locator('#addAgentInput');
      await expect(addInput).toBeVisible();
      await expect(addInput).toHaveAttribute('placeholder', /config path/i);
    });
  });

  test.describe('Rooms', () => {
    test('should switch rooms and update URL', async ({ page }) => {
      // Create unique room
      const roomName = 'testroom' + Date.now();
      await page.goto('/');

      const roomInput = page.locator('#newRoomInput');
      await roomInput.fill(roomName);
      await page.getByRole('button', { name: 'Go' }).click();

      // Verify: URL changed and room header updated
      await expect(page).toHaveURL(new RegExp(`room=${roomName}`), { timeout: 5000 });
      await expect(page.locator('main')).toContainText(`#${roomName}`);

      // Send message in this room and verify it appears
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
      const testMsg = 'Room test ' + Date.now();
      await page.locator('#messageInput').fill(testMsg);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('#messageList')).toContainText(testMsg, { timeout: 10000 });
    });

    test('should persist room topic', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      const uniqueTopic = 'Topic ' + Date.now();
      const topicInput = page.locator('#topicInput');
      await topicInput.fill(uniqueTopic);
      await topicInput.blur();
      await page.waitForTimeout(500);

      // Reload and verify topic persisted
      await page.reload();
      await expect(page.locator('#topicInput')).toHaveValue(uniqueTopic, { timeout: 5000 });
    });
  });

  test.describe('Mode Selection', () => {
    test('should persist mode selection', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      const modeSelect = page.locator('header select').first();
      await modeSelect.selectOption('turn_based');
      await page.waitForTimeout(500);

      // Reload and verify mode persisted
      await page.reload();
      await expect(page.locator('header select').first()).toHaveValue('turn_based', { timeout: 5000 });
    });

    // Note: Testing actual turn_based vs hybrid behavior requires multiple agents
    // responding which is complex to test reliably in E2E
  });

  test.describe('Start/Stop Arena', () => {
    test('should start arena and show running state', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      const startBtn = page.getByRole('button', { name: 'Start' });
      const stopBtn = page.getByRole('button', { name: 'Stop' });

      if (await startBtn.isVisible()) {
        await startBtn.click();

        // Verify: Stop button appears (arena is running)
        await expect(stopBtn).toBeVisible({ timeout: 3000 });

        // Verify: Status API confirms running
        const response = await page.request.get('/api/status');
        const status = await response.json();
        expect(status.running).toBe(true);

        // Clean up: stop the arena
        await stopBtn.click();
        await expect(startBtn).toBeVisible({ timeout: 3000 });
      }
    });

    test('should stop arena and show stopped state', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // First start it
      const startBtn = page.getByRole('button', { name: 'Start' });
      if (await startBtn.isVisible()) {
        await startBtn.click();
        await page.waitForTimeout(500);
      }

      const stopBtn = page.getByRole('button', { name: 'Stop' });
      if (await stopBtn.isVisible()) {
        await stopBtn.click();

        // Verify: Start button appears (arena is stopped)
        await expect(startBtn).toBeVisible({ timeout: 3000 });

        // Verify: Status API confirms stopped
        const response = await page.request.get('/api/status');
        const status = await response.json();
        expect(status.running).toBe(false);
      }
    });
  });

  test.describe('Delete Messages', () => {
    test('should delete individual message', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Send a unique message
      const testId = Date.now();
      const testMessage = 'Delete me ' + testId;
      await page.locator('#messageInput').fill(testMessage);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 10000 });

      // Delete it
      const ourMessage = page.locator('#messageList > div', { hasText: testMessage });
      await ourMessage.hover();
      await ourMessage.locator('button:has-text("×")').click({ force: true });

      // Verify: message is gone
      await expect(page.locator('#messageList')).not.toContainText(testMessage, { timeout: 5000 });
    });

    test('should clear all messages', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Send a message first
      const testMessage = 'Clear test ' + Date.now();
      await page.locator('#messageInput').fill(testMessage);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 10000 });

      // Accept confirm dialog
      page.on('dialog', dialog => dialog.accept());

      await page.getByRole('button', { name: 'Clear All' }).click();

      // Verify: no messages remain
      await expect(async () => {
        const count = await page.locator('#messageList > div').count();
        expect(count).toBe(0);
      }).toPass({ timeout: 5000 });
    });
  });

  test.describe('Project Management', () => {
    test('should open and close project modal', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      const newProjectBtn = page.getByRole('button', { name: '+ New Project' });
      if (await newProjectBtn.isVisible()) {
        await newProjectBtn.click();

        // Verify modal opens with form fields
        await expect(page.locator('#projectNameInput')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#projectGoalInput')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Create' })).toBeVisible();

        // Fill and submit
        const projectName = 'TestProject' + Date.now();
        await page.locator('#projectNameInput').fill(projectName);
        await page.locator('#projectGoalInput').fill('Test goal');
        await page.getByRole('button', { name: 'Create' }).click();

        // Verify modal closes
        await expect(page.locator('#modal-overlay')).toBeHidden({ timeout: 3000 });
      }
    });
  });

  test.describe('Personas Page', () => {
    test('should load and display personas', async ({ page }) => {
      await page.goto('/personas');
      await expect(page).toHaveTitle(/Persona Manager/);

      // Verify personas are actually loaded from API
      await page.waitForTimeout(1000);
      const response = await page.request.get('/api/personas');
      const personas = await response.json();

      if (personas.length > 0) {
        // Verify at least one persona name is displayed
        await expect(page.locator('body')).toContainText(personas[0].name);
      }
    });

    test('should create persona via form', async ({ page }) => {
      await page.goto('/personas');
      await page.waitForTimeout(500);

      const personaName = 'TestPersona' + Date.now();
      await page.locator('#name').fill(personaName);
      await page.locator('#description').fill('Test description');
      await page.getByRole('button', { name: 'Create Persona' }).click();

      // Verify: persona appears in list
      await expect(page.locator('body')).toContainText(personaName, { timeout: 5000 });
    });

    test('should navigate back to arena', async ({ page }) => {
      await page.goto('/personas');
      await page.getByRole('link', { name: 'Back to Arena' }).click();
      await expect(page).toHaveURL('/');
    });
  });

  test.describe('Real-time Updates', () => {
    test('should receive messages via WebSocket without refresh', async ({ page }) => {
      await page.goto('/?room=general');
      await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

      // Wait for room to be fully joined
      await page.waitForTimeout(1000);

      // Send message
      const testMessage = 'Realtime ' + Date.now();
      await page.locator('#messageInput').fill(testMessage);
      await page.getByRole('button', { name: 'Send' }).click();

      // Verify message appears WITHOUT page reload (via WebSocket)
      await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 15000 });
    });
  });
});
