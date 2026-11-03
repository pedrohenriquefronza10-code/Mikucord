# Como usar o ZIP do Tetocord

A publicação do ambiente do Codex é independente deste projeto. Você pode extrair o ZIP em outro computador e executar os arquivos diretamente.

## No seu computador

Instale **Node.js 22.19+**, npm e **Docker com Compose v2/BuildKit**. No Windows e macOS, Docker Desktop atende a esse requisito. Para criar novamente o ZIP pelo script, instale também Python 3; não é necessário para rodar o aplicativo.

No terminal, dentro da pasta `Tetocord` extraída:

```sh
npm ci
npm run setup
docker compose up -d --build postgres redis minio
npm run db:migrate
npm run media:configure
docker compose -f docker-compose.yml -f docker-compose.media.yml up -d livekit coturn
npm run dev
```

O primeiro build do MinIO compila uma versão fixada do código oficial, com checksums e TLS ativos. Pode levar vários minutos e precisa de alguns GB de disco/RAM. Builds posteriores reaproveitam cache. Não feche o terminal de `npm run dev` enquanto usar o aplicativo.

O Vite usa a porta 5173. A origem de acesso deve corresponder exatamente a `APP_ORIGIN` em `.env`; o padrão é o hostname localhost nessa porta. O backend usa 3000; a API é encaminhada pelo Vite. A exceção de segurança de localhost permite testar câmera/microfone localmente. Amigos acessando de fora precisam da instalação HTTPS descrita abaixo.

O setup gera senhas/chaves aleatórias no arquivo local `.env` e preserva valores já existentes. O ZIP inclui somente `.env.example`; nenhuma senha desta tarefa acompanha o arquivo. Não há usuário/senha padrão. Crie sua conta pela interface e anote seu identificador `nome#tag`.

Para chamadas locais, o gerador identifica um IPv4 da máquina quando MEDIA_PUBLIC_IP é o valor de desenvolvimento. Se houver várias interfaces, configure explicitamente o endereço alcançável pelo SFU/TURN. Em produção, MEDIA_PUBLIC_IP deve ser informado; o gerador não adivinha seu IP público/NAT.

## Primeiro uso

1. Crie uma conta, crie um servidor e convide a turma pelo link gerado na interface.
2. No menu do servidor, crie categorias/canais de texto, voz/vídeo, anúncios ou fórum. O menu também abre cargos e configurações administrativas.
3. No chat, anexe arquivos pelo `+` ou arraste-os para a conversa. Aguarde o progresso/verificação e envie; os anexos ficam privados ao canal. Reações, replies e edição ficam no menu sobre a mensagem.
4. Abra **Amigos e conversas** na barra de servidores para pedidos de amizade e mensagens diretas/grupos.
5. Nas configurações do usuário, abra **Temas, sons e notificações** para criar/compartilhar paletas, horários de silêncio, sons próprios e push deste navegador.
6. Nas configurações do servidor, organize emojis, figurinhas e efeitos sonoros. Efeitos têm até 10 segundos e podem ser tocados durante uma chamada autorizada; o áudio é publicado pelo SFU.

## GIFs e Web Push

A busca de GIFs usa **Tenor v2** e requer sua própria chave em `GIF_API_KEY`, em `.env`. Sem chave, o seletor mostra que o provedor não foi configurado; isso não bloqueia emojis, figurinhas nem o restante do chat. A chave não vai para o frontend. A mídia selecionada é importada e autorizada como anexo, com destinos HTTPS restritos ao provedor.

As chaves VAPID de push são geradas pelo setup. Configure `VAPID_SUBJECT` com um contato válido antes de uso remoto. O usuário precisa permitir notificações e ativá-las no navegador. A entrega depende do serviço de push do navegador; testes locais não substituem validação no navegador/dispositivo real.

## Para os amigos acessarem pela Internet

Use uma VPS ou host com **IP público alcançável**, domínio e DNS corretos. DDNS não remove CGNAT. No servidor doméstico, também será necessário encaminhar portas.

Edite `.env` antes de gerar a configuração de mídia:

- `NODE_ENV=production`.
- `APP_DOMAIN`: domínio do aplicativo, sem esquema/caminho.
- `APP_ORIGIN`: origem pública exata com HTTPS e sem barra final.
- `ACME_EMAIL`: contato válido para os certificados.
- `LIVEKIT_URL`: mesma origem pública, com esquema WSS; o Caddy encaminha `/rtc` ao SFU.
- `MEDIA_PUBLIC_IP`: IPv4 público anunciado pelo SFU/coturn.
- `TURN_HOST`: domínio ou IP público do coturn, alcançável pelos amigos.
- `MEDIA_WEBHOOK_URL`: deixe vazio para usar o backend interno em produção, ou use o endereço interno documentado no deploy.
- `VAPID_SUBJECT`: seu contato válido.

Depois:

```sh
npm run media:configure
docker compose -f docker-compose.yml -f docker-compose.media.yml --profile production up -d --build
```

Abra no firewall: **80/443 TCP** para HTTPS, **7881 TCP** e **50000–50100 UDP** para mídia LiveKit, **3478 UDP/TCP** e **49160–49200 UDP** para TURN. O signaling 7880 não precisa ficar exposto publicamente quando o Caddy fornece WSS; restrinja-o no firewall. Não exponha PostgreSQL/Redis/console MinIO.

Caddy obtém/renova HTTPS para o app. TURN usa UDP/TCP autenticado; para adicionar TURN TLS em redes mais restritas, veja `docs/deployment.md`. A configuração TURN restringe os peers ao endereço anunciado pelo SFU e usa credenciais HMAC temporárias, sem relay aberto.

Não substitua certificados válidos por exceções de navegador. Teste câmera, tela e áudio com amigos em redes diferentes antes de considerar o deploy remoto validado. A resolução efetiva depende de navegador/hardware/rede, mesmo com presets até 4K/60 sem paywall.

## Dados e atualização

Banco, cache e objetos usam volumes Docker. Faça backup consistente de PostgreSQL e MinIO e teste restauração. Para atualizar, preserve `.env` e volumes, faça backup e execute o build/migrações novos. Não use `docker compose down -v` para atualizar: essa opção remove os dados.

Os arquivos `*.generated.*` contêm configuração local com segredos e são recriados por `npm run media:configure`; não compartilhe nem versione esses arquivos. Em redes corporativas/proxy, BUILD_CA_FILE deve apontar para um bundle CA confiável; sem proxy, o projeto usa as CAs padrão das imagens. Nunca desative TLS ou a verificação de checksums para contornar falhas de instalação.
