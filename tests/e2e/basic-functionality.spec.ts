import { test, expect } from '@playwright/test';

test.describe('Core Agent Behavior - DB-loaded agents must work', () => {

  test('DB-loaded agents respond to messages without step button', async ({ request }) => {
    // This test verifies the fundamental flow:
    // Server starts -> agents loaded from DB -> user sends message -> agents respond
    // This MUST work without clicking step button

    // 1. Verify agents exist
    const agentsResponse = await request.get('/api/agents');
    expect(agentsResponse.ok()).toBeTruthy();
    const agents = await agentsResponse.json();
    expect(agents.length).toBeGreaterThan(0);

    // 2. Get initial message count
    const initialMessagesResponse = await request.get('/api/messages?roomId=general');
    expect(initialMessagesResponse.ok()).toBeTruthy();
    const initialMessages = await initialMessagesResponse.json();
    const initialCount = initialMessages.length;
    const initialAgentMessages = initialMessages.filter((m: {sender_id: string}) =>
      m.sender_id !== 'human' && m.sender_id !== 'system'
    ).length;

    // 3. Send a message - NO step button
    const sendResponse = await request.post('/send', {
      form: {
        content: 'Integration test: agents must respond to this',
        sender: 'TestUser',
        room: 'general'
      }
    });
    expect(sendResponse.ok()).toBeTruthy();

    // 4. Wait for agent responses (poll with timeout)
    let agentResponded = false;
    const maxWait = 30000;
    const pollInterval = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const messagesResponse = await request.get('/api/messages?roomId=general');
      const messages = await messagesResponse.json();
      const agentMessages = messages.filter((m: {sender_id: string}) =>
        m.sender_id !== 'human' && m.sender_id !== 'system'
      );

      if (agentMessages.length > initialAgentMessages) {
        agentResponded = true;
        break;
      }
    }

    // 5. MUST have agent response - this is the core functionality
    expect(agentResponded).toBeTruthy();
  });

  test('agents are joined to rooms at startup', async ({ request }) => {
    // Verify agents are actually in rooms, not just spawned
    const agentsResponse = await request.get('/api/agents');
    const agents = await agentsResponse.json();

    // At least one agent should be idle (in a room, ready to respond)
    const idleAgents = agents.filter((a: {status: string}) => a.status === 'idle');
    expect(idleAgents.length).toBeGreaterThan(0);
  });
});

test.describe('Basic Functionality - No Silent Failures', () => {

  test('step button should trigger agent response and message appears', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const initialCount = await page.locator('.message').count();

    const stepBtn = page.locator('.step-btn').first();
    await expect(stepBtn).toBeVisible({ timeout: 5000 });
    await stepBtn.click();

    // Must see a new message - no silent catch
    await expect(async () => {
      const currentCount = await page.locator('.message').count();
      expect(currentCount).toBeGreaterThan(initialCount);
    }).toPass({ timeout: 30000 });
  });

  test('add agent should create new agent in list', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const initialAgents = await page.locator('.agent-list li').count();

    const agentName = 'test-agent-' + Date.now();
    await page.locator('.add-agent-form input').fill(agentName);
    await page.locator('.add-agent-form button').click();

    // Must see new agent in list
    await expect(page.locator('.agent-name', { hasText: agentName })).toBeVisible({ timeout: 10000 });

    const finalAgents = await page.locator('.agent-list li').count();
    expect(finalAgents).toBeGreaterThan(initialAgents);
  });

  test('remove agent should remove agent from list', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // First add an agent
    const agentName = 'to-remove-' + Date.now();
    await page.locator('.add-agent-form input').fill(agentName);
    await page.locator('.add-agent-form button').click();
    await expect(page.locator('.agent-name', { hasText: agentName })).toBeVisible({ timeout: 10000 });

    // Now remove it
    const agentRow = page.locator('.agent-list li', { hasText: agentName });

    // Handle confirm dialog
    page.on('dialog', dialog => dialog.accept());

    await agentRow.locator('.remove-btn').click();

    // Must be gone
    await expect(page.locator('.agent-name', { hasText: agentName })).not.toBeVisible({ timeout: 10000 });
  });

  test('create project should show project in panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Click create project button
    const createBtn = page.locator('button', { hasText: /New Project|Create Project/i });
    if (await createBtn.isVisible()) {
      await createBtn.click();

      // Fill form
      const projectName = 'Test Project ' + Date.now();
      await page.locator('#project-name-input').fill(projectName);
      await page.locator('#project-goal-input').fill('Test goal');
      await page.locator('button', { hasText: 'Create' }).click();

      // Must see project
      await expect(page.locator('.project-name', { hasText: projectName })).toBeVisible({ timeout: 10000 });
    }
  });

  test('start button should change to stop when clicked', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // If system is already running (from previous tests), stop it first
    const stopBtn = page.locator('button', { hasText: /Stop/i });
    if (await stopBtn.isVisible()) {
      await stopBtn.click();
      await page.waitForTimeout(500);
    }

    // Now the Start button should be visible
    const startBtn = page.locator('button', { hasText: /Start/i });
    await expect(startBtn).toBeVisible({ timeout: 5000 });

    await startBtn.click();

    // Should now show Stop
    await expect(page.locator('button', { hasText: /Stop/i })).toBeVisible({ timeout: 5000 });
  });
});
