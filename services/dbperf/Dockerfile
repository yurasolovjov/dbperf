FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dbperf ./cmd/dbperf

FROM alpine:3.20
RUN adduser -D -u 10001 dbperf
COPY --from=build /out/dbperf /usr/local/bin/dbperf
USER dbperf
EXPOSE 9090 9091
ENTRYPOINT ["/usr/local/bin/dbperf"]
