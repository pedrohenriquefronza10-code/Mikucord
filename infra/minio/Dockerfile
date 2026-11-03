# syntax=docker/dockerfile:1
# Official MinIO source, verified by Go's checksum database. No third-party binary mirror.
FROM golang:1.24-bookworm AS build
ENV CGO_ENABLED=0 GOMAXPROCS=3
ARG MINIO_VERSION=v0.0.0-20250907161309-07c3a429bfed
RUN --mount=type=secret,id=proxy_ca,required=true \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; go mod download github.com/minio/minio@${MINIO_VERSION}
WORKDIR /go/pkg/mod/github.com/minio/minio@${MINIO_VERSION}
RUN --mount=type=secret,id=proxy_ca,required=true \
    --mount=type=cache,target=/root/.cache/go-build \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; go build -mod=readonly -p 3 -trimpath -o /out/minio .
FROM alpine:3.22
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /go/pkg/mod/github.com/minio/minio@*/LICENSE /licenses/minio/LICENSE
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
