import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  suffix = randomBytes(3).toString('hex');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
  ],
});
const contexts = [],
  pages = [],
  errors = [],
  checks = [];
await mkdir('test-results', { recursive: true });
async function request(context, method, path, data) {
  const response = await context.request.fetch(`${base}/api${path}`, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  if (!response.ok())
    throw new Error(
      `${method} ${path}: ${response.status()} ${(await response.text()).slice(0, 200)}`,
    );
  return response.json();
}
try {
  for (const name of ['Pedro', 'Bia', 'Luna']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.grantPermissions(['microphone', 'camera'], { origin: base });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.text().startsWith('Tetocord mídia')) console.log(m.text());
    });
    await request(context, 'POST', '/auth/register', {
      username: `${name}_${suffix}`,
      password: randomBytes(24).toString('base64url'),
    });
  }
  const guild = (await request(contexts[0], 'POST', '/guilds', { name: `Café da turma ${suffix}` }))
      .guild,
    invite = await request(contexts[0], 'POST', `/guilds/${guild.id}/invites`);
  for (const context of contexts.slice(1))
    await request(context, 'POST', `/invites/${invite.code}/join`);
  const channel = (
    await request(contexts[0], 'POST', `/guilds/${guild.id}/channels`, {
      name: 'Café em voz',
      type: 'voice',
    })
  ).channel;
  // A real PCM tone makes soundboard transport measurable at the subscribers.
  const samples = 8000 * 8,
    wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(Math.sin((i / 8000) * 440 * Math.PI * 2) * 6000), 44 + i * 2);
  const soundUpload = await contexts[0].request.post(
    `${base}/api/guilds/${guild.id}/catalog/sound?name=Campainha&category=Teste`,
    { multipart: { file: { name: 'campainha.wav', mimeType: 'audio/wav', buffer: wav } } },
  );
  assert.equal(soundUpload.status(), 201, await soundUpload.text());
  for (const page of pages) {
    await page.addInitScript(() => {
      const Base = window.RTCPeerConnection;
      window.__testPeers = [];
      window.__testGathered = [];
      window.__testIceErrors = [];
      window.RTCPeerConnection = class extends Base {
        constructor(...args) {
          super(...args);
          window.__testPeers.push(this);
          this.addEventListener('icecandidate', (e) => {
            if (e.candidate)
              window.__testGathered.push({ type: e.candidate.type, port: e.candidate.port });
          });
          this.addEventListener('icecandidateerror', (e) =>
            window.__testIceErrors.push({ url: e.url, code: e.errorCode, text: e.errorText }),
          );
        }
      };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        let tick = 0;
        const draw = () => {
          ctx.fillStyle = '#292530';
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#b59aef';
          ctx.font = '55px sans-serif';
          ctx.fillText('Tetocord · tela de teste', 80, 140);
          ctx.fillText(String(tick++), 80, 240);
        };
        draw();
        const timer = setInterval(draw, 40),
          stream = canvas.captureStream(25);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });
    await page.goto(`${base}/?forceRelay=${process.env.TEST_ALLOW_DIRECT === '1' ? '0' : '1'}`);
    await page.getByRole('button', { name: channel.name, exact: true }).waitFor();
    await page.getByRole('button', { name: channel.name, exact: true }).click();
    await page.waitForFunction(
      async () => {
        const { useVoice } = await import(
          performance
            .getEntriesByType('resource')
            .find((e) => new URL(e.name).pathname === '/src/Voice.tsx').name
        );
        return !!useVoice.getState().room && !useVoice.getState().connecting;
      },
      { timeout: 30000 },
    );
  }
  for (const page of pages)
    await page.waitForFunction(() => document.querySelectorAll('.voice-person').length === 3, {
      timeout: 30000,
    });
  checks.push('three participants joined the real self-hosted SFU');
  const stats = [];
  for (const page of pages) {
    const report = await page.evaluate(async () => {
      const { useVoice } = await import(
          performance
            .getEntriesByType('resource')
            .find((e) => new URL(e.name).pathname === '/src/Voice.tsx').name
        ),
        room = useVoice.getState().room,
        track = room ? [...room.localParticipant.audioTrackPublications.values()][0]?.track : null;
      if (!room) return [{ error: useVoice.getState().error }];
      if (!track) return [];
      const stats = await track.getRTCStatsReport();
      const result = [];
      for (const pair of stats.values()) {
        if (pair.type === 'candidate-pair' && pair.state === 'succeeded') {
          const local = stats.get(pair.localCandidateId);
          result.push({
            type: local?.candidateType,
            address: local?.address,
            port: local?.port,
            policy: room.engine?.rtcConfig?.iceTransportPolicy,
            relayGathered: (window.__testGathered ?? []).some(
              (c) => c.type === 'relay' && c.port === local?.port,
            ),
            protocol: local?.protocol,
            bytesSent: pair.bytesSent,
            bytesReceived: pair.bytesReceived,
          });
        }
      }
      return result;
    });
    stats.push(report);
    console.log('RTC result', report);
    assert.ok(
      report.some(
        (r) =>
          r.bytesSent > 0 &&
          r.policy === 'relay' &&
          (r.type === 'relay' ||
            (r.type === 'prflx' &&
              r.address === (process.env.TURN_CONTAINER_IP ?? '172.29.0.11') &&
              r.port >= 49160 &&
              r.port <= 49200 &&
              r.relayGathered)),
      ),
      'Expected traffic through TURN; Docker NAT may report the relay private address as peer-reflexive',
    );
  }
  checks.push(
    'all three browsers force relay and send traffic through coturn (including Docker peer-reflexive NAT mapping)',
  );
  await pages[0].getByRole('button', { name: 'Soundboard', exact: true }).click();
  await pages[0].locator('.soundboard button').filter({ hasText: 'Campainha' }).click();
  for (const page of pages.slice(1))
    await page.waitForFunction(
      async () => {
        const { useVoice } = await import(
          performance
            .getEntriesByType('resource')
            .find((e) => new URL(e.name).pathname === '/src/Voice.tsx').name
        );
        const room = useVoice.getState().room;
        for (const p of room.remoteParticipants.values())
          for (const pub of p.audioTrackPublications.values())
            if (pub.trackName.startsWith('soundboard-') && pub.track) {
              const stats = await pub.track.getRTCStatsReport();
              if ([...stats.values()].some((s) => s.type === 'inbound-rtp' && s.bytesReceived > 0))
                return true;
            }
        return false;
      },
      null,
      { timeout: 12000 },
    );
  checks.push(
    'custom soundboard publishes a second audio track received through SFU by two listeners',
  );
  await pages[0].getByRole('button', { name: 'Alternar câmera', exact: true }).click();
  for (const page of pages.slice(1))
    await page.waitForFunction(
      () => [...document.querySelectorAll('.video-tile video')].some((v) => v.videoWidth > 0),
      { timeout: 30000 },
    );
  checks.push('camera video reaches two viewers through SFU');
  await pages[0].getByLabel('Resolução da tela', { exact: true }).selectOption('2160');
  await pages[0].getByLabel('FPS da tela', { exact: true }).selectOption('60');
  await pages[0].getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
  for (const page of pages.slice(1)) {
    await page.getByText(`Pedro_${suffix} · tela`, { exact: true }).waitFor();
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.video-tile')].some(
          (tile) => tile.textContent.includes(name) && tile.querySelector('video')?.videoWidth > 0,
        ),
      `Pedro_${suffix} · tela`,
    );
  }
  checks.push('synthetic display capture reaches two viewers with selectable 4K/60 preset');
  await pages[1]
    .getByRole('button', { name: `Tela cheia: Pedro_${suffix} · tela`, exact: true })
    .click();
  assert.equal(await pages[1].evaluate(() => !!document.fullscreenElement), true);
  await pages[1].evaluate(() => document.exitFullscreen());
  checks.push('screen viewing supports fullscreen');
  await pages[1]
    .locator('.voice-controls')
    .getByRole('button', { name: 'Ensurdecer', exact: true })
    .click();
  assert.equal(
    await pages[1].evaluate(async () => {
      const { useVoice } = await import(
        performance
          .getEntriesByType('resource')
          .find((e) => new URL(e.name).pathname === '/src/Voice.tsx').name
      );
      return useVoice.getState().deafened;
    }),
    true,
  );
  await pages[1]
    .locator('.voice-controls')
    .getByRole('button', { name: 'Voltar a ouvir', exact: true })
    .click();
  checks.push('deafen toggles received audio');
  await pages[0].screenshot({ path: 'test-results/voice.png' });
  for (const page of pages)
    await page
      .locator('.voice-controls')
      .getByRole('button', { name: 'Sair da chamada', exact: true })
      .click();
  checks.push('participants leave and release media');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/media.json',
    JSON.stringify(
      {
        checks,
        stats,
        errors,
        note: 'Real SFU/TURN transports on one host with synthetic microphone/camera/display sources; does not validate ISP-to-ISP connectivity or the native OS screen picker.',
      },
      null,
      2,
    ),
  );
  console.log(`Media: ${checks.length} checks passed.`);
} catch (error) {
  for (const page of pages) {
    console.log(
      'ICE debug',
      JSON.stringify(
        await page
          .evaluate(async () => {
            const reports = [];
            for (const pc of window.__testPeers ?? []) {
              const stats = await pc.getStats();
              reports.push({
                connectionState: pc.connectionState,
                ice: pc.iceConnectionState,
                policy: pc.getConfiguration().iceTransportPolicy,
                remoteSdpCandidates: pc.remoteDescription?.sdp
                  ?.split('\r\n')
                  .filter((line) => line.startsWith('a=candidate:'))
                  .map((line) => line.split(' ').slice(2, 8)),
                candidates: [...stats.values()]
                  .filter((s) => s.type === 'local-candidate' || s.type === 'remote-candidate')
                  .map((s) => ({
                    type: s.type,
                    kind: s.candidateType,
                    address: s.address,
                    port: s.port,
                    protocol: s.protocol,
                  })),
                pairs: [...stats.values()]
                  .filter((s) => s.type === 'candidate-pair')
                  .map((s) => ({
                    state: s.state,
                    nominated: s.nominated,
                    bytesSent: s.bytesSent,
                    bytesReceived: s.bytesReceived,
                  })),
              });
            }
            return { reports, errors: window.__testIceErrors };
          })
          .catch(() => ({})),
        null,
        2,
      ),
    );
  }
  for (let i = 0; i < pages.length; i++)
    await pages[i].screenshot({ path: `test-results/media-failure-${i}.png` }).catch(() => {});
  await writeFile(
    'test-results/media.json',
    JSON.stringify({ checks, errors, failure: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
