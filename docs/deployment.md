# Deploy remoto do Tetocord

A instalação local e as imagens foram testadas. Esta entrega não publica um domínio nem emite um certificado remoto. Para acesso dos amigos, siga o [guia do ZIP](quickstart.md) e valide o host de destino com navegadores em redes diferentes.

## Serviços e exposição

| Serviço         | Função                                               | Exposição                                            |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Caddy 2         | HTTPS/ACME, proxy da API, Socket.IO e LiveKit        | 80/443 TCP e 443 UDP                                 |
| Nginx/frontend  | Build React e service worker                         | Rede interna, via Caddy                              |
| Fastify/backend | API, autorização, outbox, push, reconciliação de voz | Rede interna, via Caddy                              |
| PostgreSQL 16   | Dados/migrações                                      | Loopback do host e rede interna                      |
| Redis 7         | Presença, rate limit, adapter Socket.IO              | Loopback do host e rede interna                      |
| MinIO           | Bucket privado de arquivos/mídia                     | 9000/9001 somente em loopback                        |
| LiveKit 1.13.11 | SFU de áudio, vídeo e tela                           | WSS via Caddy; 7881 TCP, 50000–50100 UDP             |
| coturn 4.6.3    | Relay TURN autenticado                               | 3478 UDP/TCP, 49160–49200 UDP; TLS opcional 5349 TCP |

O app entrega arquivos após autorização pela API; o bucket não tem acesso público. Em VPS compartilhada, remova os mapeamentos loopback de PostgreSQL/Redis/MinIO em um override. Nunca exponha esses serviços sem controles próprios.

## Configurar e iniciar

Use uma VPS ou máquina com IPv4 público alcançável, DNS correto e firewall/encaminhamento de portas. DDNS não elimina CGNAT. Configure AAAA somente se o caminho IPv6 também funcionar. A configuração de mídia fornecida anuncia IPv4.

Depois de `npm ci` e `npm run setup`, edite `.env`:

| Variável                                                  | Valor                                       |
| --------------------------------------------------------- | ------------------------------------------- |
| NODE_ENV                                                  | production                                  |
| APP_DOMAIN                                                | domínio do aplicativo, sem esquema/caminho  |
| APP_ORIGIN                                                | origem pública HTTPS exata, sem barra final |
| ACME_EMAIL                                                | contato válido para ACME                    |
| LIVEKIT_URL                                               | mesma origem do app, com esquema WSS        |
| MEDIA_PUBLIC_IP                                           | IPv4 público do SFU/coturn                  |
| TURN_HOST                                                 | domínio ou IP alcançável do TURN            |
| MEDIA_WEBHOOK_URL                                         | vazio: usa backend interno em produção      |
| POSTGRES_PASSWORD / JWT_SECRET                            | segredos fortes gerados pelo setup          |
| S3_ACCESS_KEY / S3_SECRET_KEY                             | credenciais MinIO geradas pelo setup        |
| LIVEKIT_API_KEY / LIVEKIT_API_SECRET / TURN_SHARED_SECRET | chaves geradas pelo setup; não compartilhar |
| VAPID_SUBJECT                                             | contato válido, como mailto:seu-email       |
| GIF_API_KEY                                               | chave própria Tenor v2, se usar GIFs        |

Os segredos hexadecimais do setup funcionam na URL do banco. Senhas manuais com caracteres reservados exigem codificação na URL e ajuste da composição de DATABASE_URL. Variáveis VITE_* são públicas e não devem conter segredos.

```sh
npm run media:configure
docker compose -f docker-compose.yml -f docker-compose.media.yml --profile production up -d --build
docker compose -f docker-compose.yml -f docker-compose.media.yml --profile production ps
```

O perfil redefine URLs internas de banco, Redis, MinIO e LiveKit. Caddy encaminha `/rtc` e `/rtc/*` ao LiveKit sem remover o caminho, e `/api/*`/`/socket.io/*` ao backend. Frontend e API compartilham a origem dos cookies. Não é necessário um domínio separado para signaling. O backend rejeita APP_ORIGIN sem HTTPS em produção.

Aguarde banco e MinIO: o backend aplica migrações e repete o preparo do bucket a cada 30 segundos. Confirme 200 em `/api/health` na origem pública. Essa rota verifica banco/cache/armazenamento; faça uma chamada para testar também SFU/TURN. Consulte logs localmente, sem compartilhar tokens/chaves.

## Rede de mídia e TURN

O Compose cria uma rede de mídia dedicada (`172.29.0.0/24`), LiveKit `.10` e coturn `.11`. Coturn fica somente nessa rede; LiveKit também participa da rede da API. Isso permite ao relay alcançar o SFU diretamente, inclusive em hosts sem hairpin NAT funcional. Se o CIDR conflitar com sua rede, altere `MEDIA_SUBNET`, `LIVEKIT_CONTAINER_IP` e `TURN_CONTAINER_IP` juntos e gere a configuração novamente.

O SFU anuncia o endereço público e o interno. Coturn permite peers somente nesses endereços, rejeita os demais, usa segredo REST/HMAC e entrega credenciais temporárias por sessão autorizada. Os clientes recebem esses servidores ICE na conexão real do LiveKit. Somente STUN não substitui esse relay.

Libere as portas da tabela no firewall do host e do provedor. A porta 7880 de signaling pode ser restrita no firewall porque Caddy fornece WSS. UDP é preferível; 7881 TCP permite fallback do SFU. Não use uma regra genérica que exponha PostgreSQL, Redis ou MinIO.

Para TURN TLS, obtenha um certificado válido para TURN_HOST, coloque `fullchain.pem` e `privkey.pem` em `certs/turn/` (ignorados pelo Git/ZIP), defina `TURN_TLS_PORT=5349`, gere novamente e acrescente o override:

```sh
docker compose -f docker-compose.yml -f docker-compose.media.yml -f docker-compose.media-tls.yml --profile production up -d --build
```

O exemplo publica 5349 TCP. Configure renovação automática dos arquivos e reinicie coturn depois de renovar. Caddy não renova automaticamente o certificado do coturn. Usar TURN TLS em 443 junto com HTTPS exige IP separado ou um proxy TLS de camada 4 adequado; apenas outro subdomínio não resolve conflito no mesmo IP/porta.

Teste `?forceRelay=1` na origem do app para diagnóstico do caminho TURN. Retire esse parâmetro após o teste para permitir seleção normal ICE. Não desative validação de certificado. Navegadores remotos precisam de HTTPS válido para câmera/mic/tela; resolução/FPS e áudio do sistema dependem do navegador, hardware e rede.

## Armazenamento e operação

Uploads de chat aceitam qualquer tipo de arquivo, por partes, com spool temporário por parte e hash do objeto completo; não carregam o arquivo inteiro em memória. S3 limita o objeto a 5 TiB e 10.000 partes; o tamanho de parte é calculado conforme o arquivo. Há cinco sessões simultâneas por usuário, vinte anexos por mensagem e limites de frequência. Envios interrompidos podem ser cancelados nas preferências. O navegador mantém os arquivos para retry enquanto a página está aberta; não retoma automaticamente após fechar/recarregar.

Perfis e catálogos têm processamento limitado a 20 MB por arquivo; imagens têm até 40 milhões de pixels. Efeitos de soundboard têm até 10 segundos e sons de notificação até 30 segundos, medidos a partir do áudio real. Download usa streaming e Range; conteúdo HTML/SVG não é executado inline. Deduplicação é global por SHA-256 e cada referência conserva sua autorização privada.

Monitore disco temporário, volumes MinIO/PostgreSQL, CPU de transcodificação do navegador e banda do SFU/TURN. Não há coleta física automática dos blobs de mensagens excluídas/perfis substituídos nem expurgo automático da auditoria/outbox. Exclusão lógica revoga o acesso, mas não garante liberação imediata de espaço. Configure política de retenção/limpeza compatível com referências compartilhadas antes de uso prolongado; não remova objetos por nome sem consultar suas referências.

Faça backup consistente de PostgreSQL e MinIO, preserve `.env` e as chaves e teste restauração. Volume Docker não é backup. Atualize com backup, novas migrações e build, sem editar SQL aplicado. **Não use `docker compose down -v` para atualizar**, pois remove os volumes.

MinIO é compilado de fonte oficial fixada com Go/SumDB; o primeiro build requer os registries, proxy.golang.org, sum.golang.org e storage.googleapis.com. Em rede com proxy, BUILD_CA_FILE aponta para um bundle confiável montado como segredo BuildKit. Sem proxy, usa CAs padrão das imagens. Mantenha verificação TLS/checksums ativa.

## Teste no host de destino

Use contas próprias de teste: convites/chat/histórico; canal privado e revogação; upload/download grande; GIF com a chave configurada; push com permissão; chamada com câmera/tela e dois espectadores em redes/operadoras diferentes; relay forçado, mute/deafen/volume/soundboard; persistência após reinício. Os testes automatizados locais estão detalhados em [validation.md](validation.md).
