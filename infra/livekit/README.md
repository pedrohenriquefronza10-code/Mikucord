# LiveKit SFU

`npm run media:configure` gera `livekit.generated.yaml` a partir do `.env`: chaves, IPv4 anunciado, faixa UDP e webhook assinado. O arquivo contém segredos e não acompanha Git/ZIP. `docker-compose.media.yml` inicia LiveKit 1.13.11 e coturn; Caddy encaminha WSS na mesma origem do app.

Backend emite tokens curtos por sala e por fonte, verifica webhooks e reconcilia participantes/permissões. Frontend publica uma vez para o SFU; espectadores assinam o mesmo stream. Veja [deploy](../../docs/deployment.md) para endereços, portas e testes remotos.
