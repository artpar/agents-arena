import { test, expect } from '@playwright/test';

/**
 * Tests for data consistency issues that have caused bugs:
 * - Description disappearing after actions
 * - WebSocket events not updating UI
 * - API returning incomplete data
 */

test.describe('Data Consistency', () => {

  test('agent descriptions should persist after step', async ({ request }) => {
    // Get agents
    const agentsRes = await request.get('/api/agents');
    const agents = await agentsRes.json();
    expect(agents.length).toBeGreaterThan(0);

    // Find an agent with a description
    const agentWithDesc = agents.find((a: any) => a.description && a.description.length > 0);
    if (!agentWithDesc) {
      test.skip();
      return;
    }

    const originalDesc = agentWithDesc.description;

    // Step the agent
    await request.post(`/agents/${agentWithDesc.id}/step`, {
      data: { roomId: 'general' }
    });

    // Wait a moment for any state changes
    await new Promise(r => setTimeout(r, 1000));

    // Get agents again
    const agentsRes2 = await request.get('/api/agents');
    const agents2 = await agentsRes2.json();
    const agentAfter = agents2.find((a: any) => a.id === agentWithDesc.id);

    // Description should be unchanged
    expect(agentAfter.description).toBe(originalDesc);
  });

  test('API should return agent descriptions from config', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents = await agentsRes.json();

    // At least some agents should have descriptions
    const agentsWithDesc = agents.filter((a: any) => a.description && a.description.length > 0);
    expect(agentsWithDesc.length).toBeGreaterThan(0);
  });

  test('all expected agent fields should be present', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents = await agentsRes.json();
    expect(agents.length).toBeGreaterThan(0);

    const agent = agents[0];
    expect(agent).toHaveProperty('id');
    expect(agent).toHaveProperty('name');
    expect(agent).toHaveProperty('description');
    expect(agent).toHaveProperty('status');
  });
});

test.describe('WebSocket Event Handling', () => {

  test('agent_status events should update UI', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    // Find an agent and trigger step
    const agentSection = page.locator('aside');
    const agentRow = agentSection.locator('div.group').first();

    if (await agentRow.isVisible()) {
      // Get agent name before step
      const agentName = await agentRow.locator('.font-medium').textContent();

      await agentRow.hover();
      const stepBtn = agentRow.getByRole('button', { name: 'Step' });

      if (await stepBtn.isVisible()) {
        await stepBtn.click();

        // Should show thinking indicator (yellow background or thinking label)
        await expect(agentRow.locator('.text-yellow-400')).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('message_added events should appear without refresh', async ({ page }) => {
    await page.goto('/?room=general');
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    const testMessage = 'Consistency test ' + Date.now();
    await page.locator('#messageInput').fill(testMessage);
    await page.getByRole('button', { name: 'Send' }).click();

    // Message should appear via WebSocket without page refresh
    await expect(page.locator('#messageList')).toContainText(testMessage, { timeout: 10000 });
  });
});

test.describe('State Preservation', () => {

  test('input value should not be lost during state updates', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    const testText = 'Typing this message...';
    const input = page.locator('#messageInput');
    await input.fill(testText);

    // Trigger a state update by waiting (WebSocket messages may arrive)
    await page.waitForTimeout(2000);

    // Input should still have our text
    await expect(input).toHaveValue(testText);
  });

  test('topic input should not lose focus during updates', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    const topicInput = page.locator('#topicInput');
    await topicInput.click();
    await topicInput.fill('Test topic');

    // Should still be focused
    await expect(topicInput).toBeFocused();
  });
});
