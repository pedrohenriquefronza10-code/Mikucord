# coturn

`npm run media:configure` gera `turnserver.generated.conf` localmente, com segredo REST/HMAC temporário, portas e peers restritos ao SFU. O arquivo contém segredo e não acompanha Git/ZIP. `docker-compose.media.yml` inicia o serviço integrado ao LiveKit; o backend entrega credenciais ICE temporárias a participantes autorizados.

Veja [deploy](../docs/deployment.md) para IP público, firewall, rede de mídia dedicada, TLS opcional e diagnóstico com relay forçado. Não exponha um relay sem autenticação.
