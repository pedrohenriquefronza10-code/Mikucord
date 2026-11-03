import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const base = process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  suffix = randomBytes(3).toString('hex'),
  password = randomBytes(24).toString('base64url');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const owner = await browser.newContext({ viewport: { width: 1440, height: 960 } }),
  friend = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await owner.newPage(),
  other = await friend.newPage(),
  errors = [],
  checks = [];
for (const p of [page, other]) p.on('pageerror', (e) => errors.push(e.message));
await mkdir('test-results', { recursive: true });
async function register(p, name) {
  await p.getByRole('button', { name: 'Pode chegar', exact: true }).click();
  await p.locator('input[name=username]').fill(name);
  await p.locator('input[name=password]').fill(password);
  await p.getByRole('button', { name: 'Criar minha conta', exact: true }).click();
  await p.getByRole('button', { name: 'Configurações do usuário' }).waitFor();
}
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Bom te ver por aqui.' }).waitFor();
  await page.screenshot({ path: 'test-results/auth.png' });
  checks.push('login page renders');
  await register(page, `Pedro_${suffix}`);
  checks.push('registration through real UI');
  await page.getByRole('button', { name: 'Criar meu servidor', exact: true }).click();
  const create = page.getByRole('dialog');
  await create.getByLabel('Nome do servidor').fill('Nosso cantinho');
  await create.locator('textarea').fill('Entre, puxe uma cadeira e fique à vontade.');
  await create.getByRole('button', { name: 'Criar meu servidor', exact: true }).click();
  await page.getByRole('heading', { name: 'Esse é o começo de #geral' }).waitFor();
  checks.push('server + default category and channel');
  await page.getByRole('button', { name: 'Convidar amigos', exact: true }).click();
  await page.getByRole('button', { name: 'Gerar link de convite' }).click();
  const invite = await page.getByRole('dialog').locator('input[readonly]').inputValue();
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await other.goto(invite);
  await register(other, `Bia_${suffix}`);
  await other.getByRole('heading', { name: 'Esse é o começo de #geral' }).waitFor();
  checks.push('second browser accepts invite after registration');
  const composer = other.getByRole('textbox', { name: 'Conversar em #geral' });
  await composer.fill('Cheguei! Bora colocar o papo em dia? 🌱');
  await other.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await page.getByText('Cheguei! Bora colocar o papo em dia? 🌱', { exact: true }).waitFor();
  checks.push('real-time message between isolated browser sessions');
  const message = page
    .locator('article')
    .filter({ hasText: 'Cheguei! Bora colocar o papo em dia?' });
  await message.hover();
  await message.getByRole('button', { name: `Responder Bia_${suffix}` }).click();
  await page
    .getByRole('textbox', { name: 'Conversar em #geral' })
    .fill('Agora sim, a turma tá completa! 💜');
  await page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await other.getByText('Agora sim, a turma tá completa! 💜', { exact: true }).waitFor();
  checks.push('reply with persisted quoted message');
  const own = page.locator('article').filter({ hasText: 'Agora sim, a turma tá completa!' });
  await own.hover();
  await own.getByRole('button', { name: 'Editar mensagem' }).click();
  await own.locator('.edit-form textarea').fill('Agora sim, nosso cantinho tá completo! 💜');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await other
    .locator('.message-content')
    .filter({ hasText: 'Agora sim, nosso cantinho tá completo! 💜' })
    .waitFor();
  checks.push('editing propagates in real time');
  await page.getByRole('button', { name: 'Mencionar alguém' }).click();
  await page
    .locator('.composer-picker button')
    .filter({ hasText: `Bia_${suffix}` })
    .click();
  await page.getByRole('textbox', { name: 'Conversar em #geral' }).press('End');
  await page
    .getByRole('textbox', { name: 'Conversar em #geral' })
    .pressSequentially(' café e conversa? ☕');
  await page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await other.getByText('café e conversa?', { exact: false }).waitFor();
  checks.push('user mention picker');
  await page.locator('.guild-header>button').click();
  await page.getByRole('button', { name: 'Gerenciar cargos', exact: true }).click();
  const roles = page.getByRole('dialog');
  await roles.getByLabel('Nome do cargo').fill('Amigos');
  await roles.getByLabel('Cor', { exact: true }).fill('#91d4bd');
  await roles.getByRole('button', { name: 'Criar', exact: true }).click();
  await roles
    .locator('.role-member-list')
    .getByRole('button')
    .filter({ hasText: `Bia_${suffix}` })
    .click();
  await page
    .locator('.members-sidebar .member')
    .filter({ hasText: `Bia_${suffix}` })
    .getByText('Amigos', { exact: true })
    .waitFor();
  await roles.getByRole('button', { name: 'Fechar', exact: true }).click();
  checks.push('colored role creation + assignment');
  await other.getByRole('button', { name: 'Configurações do usuário' }).click();
  await other.getByRole('dialog').getByLabel('O que está rolando?').fill('🎮 Só mais uma partida');
  await other.getByRole('dialog').getByLabel('Status', { exact: true }).selectOption('idle');
  await other.getByRole('button', { name: 'Salvar alterações' }).click();
  await page
    .locator('.member')
    .filter({ hasText: `Bia_${suffix}` })
    .locator('.status-dot.idle')
    .waitFor();
  checks.push('custom status and presence update');
  await other.getByRole('button', { name: 'Configurações do usuário' }).click();
  await other.getByRole('button', { name: 'Aparência', exact: true }).click();
  await other.getByRole('button', { name: 'Clarinho', exact: false }).click();
  await other.getByRole('button', { name: 'Salvar alterações' }).click();
  await other.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await other.screenshot({ path: 'test-results/light.png' });
  checks.push('persisted light theme');
  await composer.fill('<img src=x onerror="window.__xss=1">');
  await other.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await page.getByText('<img src=x onerror="window.__xss=1">', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  checks.push('message HTML rendered as text');
  const unsafeText = other
    .locator('article')
    .filter({ hasText: '<img src=x onerror="window.__xss=1">' });
  await unsafeText.hover();
  await unsafeText.getByRole('button', { name: 'Excluir mensagem', exact: true }).click();
  await other
    .getByRole('dialog')
    .getByRole('button', { name: 'Excluir mensagem', exact: true })
    .click();
  await page.getByText('Mensagem excluída', { exact: true }).waitFor();
  checks.push('deletion dialog and real-time tombstone');
  await page.screenshot({ path: 'test-results/chat.png' });
  await page.reload();
  await page
    .locator('.message-content')
    .filter({ hasText: 'Agora sim, nosso cantinho tá completo! 💜' })
    .waitFor();
  checks.push('history survives reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Mostrar canais' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/mobile.png', animations: 'disabled' });
  checks.push('390px responsive layout without horizontal overflow');
  await page.getByRole('button', { name: 'Mostrar canais' }).click();
  await page.getByRole('button', { name: 'Configurações do usuário' }).click();
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await page.getByRole('heading', { name: 'Bom te ver por aqui.' }).waitFor();
  checks.push('logout returns to login');
  assert.deepEqual(errors, []);
  checks.push('no uncaught browser errors');
  console.log(`Browser: ${checks.length} checks passed.`);
  await writeFile(
    'test-results/browser.json',
    JSON.stringify(
      {
        checks,
        errors,
        storage:
          'Not exercised by this browser suite. Check the integration report; profile uploads require running MinIO.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
  await writeFile(
    'test-results/browser.json',
    JSON.stringify({ checks, errors, failure: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
