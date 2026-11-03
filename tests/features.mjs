import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import assert from 'node:assert/strict';
const base = process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  suffix = randomBytes(3).toString('hex');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const a = await browser.newContext({ viewport: { width: 1440, height: 960 } }),
  b = await browser.newContext({ viewport: { width: 1366, height: 900 } }),
  owner = await a.newPage(),
  friend = await b.newPage(),
  checks = [],
  errors = [];
for (const page of [owner, friend]) page.on('pageerror', (e) => errors.push(e.message));
async function request(context, method, path, data) {
  const response = await context.request.fetch(`${base}/api${path}`, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  if (!response.ok())
    throw new Error(
      `${method} ${path}: ${response.status()} ${(await response.text()).slice(0, 150)}`,
    );
  return response.json();
}
await mkdir('test-results', { recursive: true });
try {
  const alice = (
      await request(a, 'POST', '/auth/register', {
        username: `Pedro_${suffix}`,
        password: randomBytes(24).toString('hex'),
      })
    ).user,
    bob = (
      await request(b, 'POST', '/auth/register', {
        username: `Bia_${suffix}`,
        password: randomBytes(24).toString('hex'),
      })
    ).user;
  const guild = (await request(a, 'POST', '/guilds', { name: `Nosso universo ${suffix}` })).guild,
    invite = await request(a, 'POST', `/guilds/${guild.id}/invites`);
  await request(b, 'POST', `/invites/${invite.code}/join`);
  const channels = (await request(a, 'GET', `/guilds/${guild.id}/channels`)).channels,
    channel = channels.find((c) => c.type === 'text');
  await Promise.all([owner.goto(base), friend.goto(base)]);
  for (const page of [owner, friend])
    await page.getByRole('heading', { name: 'Esse é o começo de #geral' }).waitFor();
  const png = await sharp({ create: { width: 30, height: 24, channels: 4, background: '#b59aef' } })
      .png()
      .toBuffer(),
    text = Buffer.from('Boas conversas e boas companhias.\n');
  await owner.getByLabel('Selecionar arquivos', { exact: true }).setInputFiles([
    { name: 'memorias.txt', mimeType: 'text/plain', buffer: text },
    { name: 'foto.png', mimeType: 'image/png', buffer: png },
  ]);
  await owner.waitForFunction(
    () => document.querySelectorAll('.upload-draft.ready').length === 2,
    null,
    { timeout: 30000 },
  );
  checks.push('two real files upload through chunked browser transport');
  await owner.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await friend.getByRole('button', { name: 'Baixar memorias.txt', exact: true }).waitFor();
  await friend.waitForFunction(
    () => document.querySelector('img[alt="foto.png"]')?.naturalWidth === 30,
  );
  checks.push('file-only message and authenticated inline image preview');
  await friend.waitForFunction(() => !!navigator.serviceWorker.controller);
  const downloadPromise = friend.waitForEvent('download');
  await friend.getByRole('button', { name: 'Baixar memorias.txt', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'memorias.txt');
  assert.deepEqual(await readFile(await download.path()), text);
  checks.push('streaming service-worker download preserves filename and bytes');
  await owner.locator('.guild-header>button').click();
  await owner.getByRole('button', { name: 'Configurar servidor', exact: true }).click();
  let dialog = owner.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Emojis, figurinhas e sons', exact: true }).click();
  await dialog.getByLabel('Nome da expressão', { exact: true }).fill('cafe');
  await dialog
    .getByLabel('Arquivo da expressão', { exact: true })
    .setInputFiles({ name: 'cafe.png', mimeType: 'image/png', buffer: png });
  await dialog.getByRole('button', { name: 'Adicionar ao catálogo', exact: true }).click();
  await dialog.locator('.catalog-management img[alt="cafe"]').waitFor();
  checks.push('admin uploads a custom emoji through catalog UI');
  await dialog.getByLabel('Tipo de expressão', { exact: true }).selectOption('sticker');
  await dialog.getByLabel('Nome da expressão', { exact: true }).fill('Abraço');
  await dialog
    .getByLabel('Arquivo da expressão', { exact: true })
    .setInputFiles({ name: 'abraco.png', mimeType: 'image/png', buffer: png });
  await dialog.getByRole('button', { name: 'Adicionar ao catálogo', exact: true }).click();
  await dialog.locator('.catalog-management img[alt="Abraço"]').waitFor();
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  checks.push('admin uploads a separate custom sticker');
  await owner.getByRole('button', { name: 'Inserir emoji', exact: true }).click();
  await owner.locator('.custom-emoji-grid button[title=":cafe:"]').click();
  await owner.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await friend.locator('.message-content img[alt=":cafe:"]').waitFor();
  checks.push('custom emoji renders in a live message');
  await owner.getByRole('button', { name: 'Escolher figurinha', exact: true }).click();
  await owner.locator('.sticker-grid button[title="Abraço"]').click();
  await owner.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await friend.locator('.message-stickers img[alt="Abraço"]').waitFor();
  checks.push('dedicated sticker picker sends a sticker-only message');
  const message = (
    await request(a, 'POST', `/channels/${channel.id}/messages`, {
      content: 'Boas companhias fazem o nosso universo.',
      clientNonce: crypto.randomUUID(),
    })
  ).message;
  await request(b, 'PUT', `/messages/${message.id}/reactions`, { emoji: '💜' });
  await owner.locator('.reaction-bar button').filter({ hasText: '💜' }).waitFor();
  await owner.locator('.reaction-bar button').filter({ hasText: '💜' }).click();
  await owner.locator('.reaction-bar button.reacted').filter({ hasText: '2' }).waitFor();
  checks.push('reaction toggle and count update live');
  await owner.getByRole('button', { name: 'Configurações do usuário' }).click();
  await owner.getByRole('button', { name: 'Temas, sons e notificações' }).click();
  dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Nome do tema', { exact: true }).fill('Jardim compartilhado');
  await dialog.getByLabel('Cor Fundo', { exact: true }).fill('#20332b');
  await dialog.getByLabel(/Compartilhar com/).selectOption(guild.id);
  await dialog.getByRole('button', { name: 'Salvar e aplicar tema', exact: true }).click();
  await owner.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--bg') === '#20332b',
  );
  checks.push('theme editor saves and applies custom colors');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await friend.getByRole('button', { name: 'Configurações do usuário' }).click();
  await friend.getByRole('button', { name: 'Temas, sons e notificações' }).click();
  dialog = friend.getByRole('dialog');
  await dialog.locator('.saved-themes button').filter({ hasText: 'Jardim compartilhado' }).click();
  await friend.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--bg') === '#20332b',
  );
  checks.push('another member applies the shared theme');
  await dialog.getByRole('button', { name: 'Notificações', exact: true }).click();
  await dialog.getByLabel('Ativar horários de silêncio', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Adicionar horário', exact: false }).click();
  await dialog.getByRole('button', { name: 'Salvar notificações', exact: true }).click();
  await friend.getByText('Preferências de notificação salvas.', { exact: true }).waitFor();
  checks.push('quiet-hour preferences save from the UI');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await request(a, 'POST', '/friends/requests', { userId: bob.id });
  await friend.locator('.home-server').click();
  await friend.getByRole('button', { name: /Pedidos/ }).click();
  await friend.getByRole('button', { name: 'Aceitar', exact: true }).click();
  await friend.getByRole('button', { name: /Amigos \(/ }).click();
  await friend.locator('.people-list>div').filter({ hasText: alice.username }).waitFor();
  checks.push('friend request accepted through UI');
  await owner.locator('.home-server').click();
  await owner
    .locator('.people-list>div')
    .filter({ hasText: bob.username })
    .getByRole('button', { name: 'Conversar', exact: true })
    .click();
  await owner.locator('.composer>textarea').fill('Uma conversa privada com café.');
  await owner.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await friend.locator('.direct-sidebar .channel-link').filter({ hasText: alice.username }).click();
  await friend.getByText('Uma conversa privada com café.', { exact: true }).waitFor();
  checks.push('direct conversation sends and receives real-time messages');
  await owner.locator('.home-server').click();
  await owner.getByRole('button', { name: 'Criar grupo', exact: true }).click();
  await owner.getByLabel('Nome do grupo', { exact: true }).fill('Turma do café');
  await owner.getByLabel(bob.username, { exact: true }).check();
  await owner.locator('.social-panel form button.primary').click();
  await owner.locator('.composer>textarea').waitFor();
  await owner.locator('.composer>textarea').fill('Bem-vindos ao nosso grupo!');
  await owner.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
  await friend
    .locator('.direct-sidebar .channel-link')
    .filter({ hasText: 'Turma do café' })
    .click();
  await friend.getByText('Bem-vindos ao nosso grupo!', { exact: true }).waitFor();
  checks.push('group DM creation and delivery through the UI');
  await owner.getByRole('button', { name: 'Buscar mensagens', exact: true }).click();
  await owner.getByLabel('Texto da busca', { exact: true }).fill('privada');
  await owner
    .getByRole('button', { name: 'Buscar mensagens', exact: true })
    .filter({ hasText: 'Buscar mensagens' })
    .click();
  await owner
    .locator('.search-results button')
    .filter({ hasText: 'Uma conversa privada com café.' })
    .click();
  await owner
    .locator('.message-focus')
    .getByText('Uma conversa privada com café.', { exact: true })
    .waitFor();
  checks.push('global search opens the authorized message context');
  await owner.getByRole('button', { name: `Abrir ${guild.name}`, exact: true }).click();
  await owner.getByRole('heading', { name: 'Esse é o começo de #geral' }).waitFor();
  await owner.screenshot({ path: 'test-results/features.png' });
  assert.deepEqual(errors, []);
  checks.push('no uncaught browser errors');
  await writeFile('test-results/features.json', JSON.stringify({ checks, errors }, null, 2));
  console.log(`Features: ${checks.length} browser checks passed.`);
} catch (error) {
  await owner.screenshot({ path: 'test-results/features-failure-owner.png' }).catch(() => {});
  await friend.screenshot({ path: 'test-results/features-failure-friend.png' }).catch(() => {});
  await writeFile(
    'test-results/features.json',
    JSON.stringify({ checks, errors, failure: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
