# Validação da entrega — 3 de novembro de 2026

## Resultados

| Verificação                | Resultado observado                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| TypeScript e build         | Frontend/backend passaram                                                           |
| Integração completa        | 25 testes passaram, 0 falhas, 0 pulos, com PostgreSQL/Redis/MinIO reais             |
| Navegador — base           | 17 verificações passaram, dois contextos Chromium                                   |
| Navegador — extras         | 16 verificações passaram, dois contextos Chromium                                   |
| Navegador — mídia          | 8 verificações passaram, três contextos Chromium, SFU e TURN reais                  |
| Auditoria npm de produção  | 0 vulnerabilidades reportadas                                                       |
| Readiness                  | `/api/health` respondeu 200 com banco, cache e bucket disponíveis                   |
| Docker                     | Imagens frontend/backend construídas com lockfile e verificação TLS                 |
| Imagem de produção         | Health, bloqueio anônimo/origem e processamento Sharp passaram; Nginx/Caddy válidos |
| ZIP extraído em pasta nova | npm ci com TLS, setup, geração de mídia, Compose, typecheck e build passaram        |

Os comandos são `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:features` e `npm run test:media`. Chromium usa `/usr/bin/chromium` ou CHROMIUM_PATH. Os relatórios/screenshots são produzidos em `test-results/`, fora do Git e do ZIP. A integração usa banco/bucket temporários e namespace Redis isolado; os testes de navegador criam contas/servidores aleatórios no banco de desenvolvimento.

## Integração e privacidade

Registro/login, validação de senha bcrypt, origem/CSRF, refresh rotativo com replay/logout, convites idempotentes e limitados, presença multiaba, autorização dos sockets, cargos, menções, replies, edição com versão, tombstones, saída de servidor e revogação de mídia.

Anexo real acima de 25 MB, partes persistidas/retry, SHA-256/deduplicação, anexo privado, Range 206/416, acesso negado a terceiros e por rota de asset genérico, cancelamento/incompletude, validação real de imagens e duração de WAV. Emojis preservam referência/nome digitado após renomeação; stickers e reações usam relações persistidas. Temas respeitam propriedade/compartilhamento. Amizades, bloqueios, DMs/grupos e busca respeitam associação atual. Fórum herda a categoria privada e membros comuns podem publicar no fórum permitido.

Tokens LiveKit foram verificados quanto a sala, fontes e expiração; credenciais TURN quanto ao HMAC e prazo. Webhooks falsos foram rejeitados e assinados aceitos uma vez. Agendamento verifica fuso e sobreposição. Push rejeita endpoint arbitrário de rede. Sem chave de GIF, o endpoint responde indisponibilidade explícita; isso não foi contado como teste do provedor externo.

## Navegador

Base: registro, servidor/convite, chat ao vivo, reply, edição, menção, cargo colorido, status, tema claro persistido, HTML mostrado como texto, exclusão ao vivo, histórico após reload, logout e layout de 390px sem overflow da página.

Extras: dois arquivos reais enviados pela interface, mensagem só de anexos, imagem autenticada inline, download pelo service worker com nome e bytes exatos, upload administrativo de emoji/sticker, pickers separados e entrega ao vivo, reações/contagem, paleta pessoal, tema compartilhado aplicado por outro membro, silêncio salvo, amizade aceita, DMs/grupos e busca abrindo o contexto autorizado. Sem exceções de página não tratadas.

Mídia: três participantes conectaram ao LiveKit; os três usaram política ICE `relay` com tráfego real no coturn. O Docker traduziu o candidato para o endereço privado do relay (peer-reflexive); o teste cruzou endereço, faixa/porta, candidato relay originalmente coletado e bytes transferidos. Um som WAV foi publicado como segunda faixa de áudio e recebido pelos dois ouvintes. Câmera foi decodificada nos dois espectadores, assim como a tela sintética; seleção 4K/60, fullscreen, deafen e saída foram exercitados.

## Limites da validação

- Câmera/mic sintéticos do Chromium e tela gerada por canvas: o transporte é real, mas isso não valida o seletor nativo do sistema, áudio do sistema, captura física 4K/60 nem desempenho de hardware real.
- Os três navegadores e serviços rodaram no mesmo host. Não houve teste entre operadoras/ISPs, deploy em domínio público ou emissão de certificado. O projeto inclui HTTPS/WSS, SFU e TURN; o host de destino ainda precisa dos testes do guia de deploy.
- Tenor não foi consultado com uma chave do usuário. O caminho de integração existe e requer GIF_API_KEY própria.
- A inscrição/worker Web Push está implementada com VAPID, autorização e preferências; entrega real por um provedor/dispositivo externo não foi validada. Exige contato configurado, permissão do usuário e rede disponível.
- Cancelar/repetir upload funciona na página aberta. Não há retomada automática após fechar/recarregar. Sessões interrompidas podem ser canceladas nas preferências.
- Exclusão lógica revoga acesso; não há coletor físico automático de blobs órfãos nem política automática de retenção da auditoria/outbox. Faça backup e monitore disco.

O ZIP distribui fonte, migrações, lockfile, documentação e exemplos. Não inclui `.env`, configurações geradas, contas, dados, certificados privados ou dependências instaladas. O empacotador testa CRC e hashes por arquivo; a extração deve passar pela instalação/build descritos no guia.
