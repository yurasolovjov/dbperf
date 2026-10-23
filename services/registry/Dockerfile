FROM golang:1.27-alpine AS build
WORKDIR /src
COPY . .
RUN cd services/registry && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/registry ./cmd/registry \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/registryctl ./cmd/registryctl

FROM scratch
COPY --from=build /out/registry /registry
COPY --from=build /out/registryctl /registryctl
EXPOSE 9100 9101
ENTRYPOINT ["/registry"]
