# Tetocord

Aplicativo privado de comunicação para um grupo de amigos: servidores, canais, mensagens, arquivos, chamadas, temas e conversas diretas. Interface em português, com barra de servidores, lista de canais, chat, membros e painel de voz persistente.

**Comece por [Como usar o ZIP](docs/quickstart.md).** Não é necessário publicar o ambiente do Codex para executar o projeto em outro computador. O pacote contém código-fonte e configurações de exemplo; `npm run setup` gera credenciais locais, sem conta/senha padrão.

## Recursos das seis fases

| Fase               | Implementação                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Base           | Registro com nome#tag, JWT/refresh, perfil animado, servidores/convites, categorias/canais, chat persistido em tempo real, replies, edição, exclusão, menções e presença Redis.                 |
| 2 — Arquivos       | Arrastar e soltar, upload por partes com progresso/retry, imagens/vídeos/áudios inline, download autenticado com progresso, Range e deduplicação SHA-256.                                       |
| 3 — Chamadas       | LiveKit self-hosted com coturn autenticado, múltiplos participantes, mic/mute/deafen/volume, câmera, tela com áudio quando suportado, presets 720p–4K e 15/30/60fps, fullscreen e moderação.    |
| 4 — Expressões     | Emoji picker completo, emojis e figurinhas do servidor, GIFs Tenor, soundboard transmitido pelo SFU, upload/renomeação/exclusão e atalhos próprios.                                             |
| 5 — Personalização | Escuro/claro, paletas pessoais e compartilhadas, cores do servidor, densidade/fonte/membros, avatares/banners animados, sons próprios, ícones de cargos e boost simbólico.                      |
| 6 — Extras         | Reações Unicode/customizadas, busca global com filtros e contexto, Web Push, amizades/DMs/grupos, status com emoji, sobrescritas por cargo/membro/canal, auditoria e silêncio por fuso/horário. |

GIFs requerem uma chave Tenor própria em `GIF_API_KEY`. Web Push requer permissão do usuário e um serviço de push alcançável. O deploy remoto requer domínio, HTTPS válido, IP alcançável e portas de mídia/TURN. Veja [validação e limites dos testes](docs/validation.md); a implementação local não equivale a um deploy público validado.

O boost é simbólico e não impõe paywall: catálogos e mídia animada permanecem disponíveis. Os arquivos de chat não têm um teto comercial em MB; aplicam-se disco disponível, capacidade do navegador e limites reais do protocolo S3 (5 TiB por objeto). Há limites operacionais para concorrência, partes e frequência. Imagens de perfil/catálogo e sons curtos têm limites de processamento separados e documentados.

## Executar localmente

Requisitos: Node.js 22.19+, npm, Docker/Compose v2 com BuildKit. No Windows/macOS, use Docker Desktop. O primeiro build do MinIO compila fonte oficial fixada e pode levar vários minutos.

```sh
npm ci
npm run setup
docker compose up -d --build postgres redis minio
npm run db:migrate
npm run media:configure
docker compose -f docker-compose.yml -f docker-compose.media.yml up -d livekit coturn
npm run dev
```

Vite usa 5173; backend usa 3000 e é encaminhado pela mesma origem. `APP_ORIGIN` deve coincidir exatamente com o hostname/porta usados pelo navegador. O backend aplica migrações com lock/checksum, prepara bucket privado e só retorna 200 em `/api/health` quando PostgreSQL, Redis e MinIO estão disponíveis. Chamadas dependem adicionalmente dos serviços de mídia.

## Verificar e empacotar

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:features
npm run test:media
npm run package
```

Integração cria/remove banco e bucket temporários e usa Redis DB 15 com namespace próprio; execute em desenvolvimento. Testes de navegador requerem `npm run dev` ativo e Chromium (`CHROMIUM_PATH`; padrão `/usr/bin/chromium`). Criam contas aleatórias no banco de desenvolvimento e relatórios em `test-results/`. O teste de mídia usa fontes sintéticas e tráfego real pelo SFU/TURN, com relay forçado.

O empacotador requer Python 3 e gera `../artifacts/Tetocord.zip`, hashes SHA-256 e verificação de integridade. Exclui `.env`, configurações geradas, dependências, builds, dados e relatórios de teste. O usuário que extrair deve executar a instalação acima.

## Arquitetura

React 19 + TypeScript + Vite + Tailwind CSS + Zustand + Framer Motion; Fastify + Socket.IO; PostgreSQL 16 + Redis 7; MinIO privado; LiveKit + coturn; Caddy com HTTPS automático e Nginx para os arquivos estáticos. Cookies HttpOnly, refresh rotativo, autorização atual em REST/socket/mídia, rate limiting, outbox transacional, conteúdo renderizado como texto e CSP.

```text
frontend/              interface, serviço de download/push, WebRTC
backend/src/           API, permissões, mensagens, uploads, mídia e workers
backend/migrations/    evolução SQL com checksums; não editar migrações aplicadas
backend/test/          integração com serviços reais
scripts/               setup, configuração de mídia, testes e ZIP
tests/                 fluxos Playwright de base, extras e mídia
infra/                 Caddy, LiveKit, build MinIO e CA de build opcional
coturn/                configuração TURN gerada localmente
```

[Schema proposto e mapa de migrações](docs/database-schema.md) · [Schema SQL implementado](docs/schema.sql) · [Deploy, portas e backups](docs/deployment.md) · [Resultados de validação](docs/validation.md)
