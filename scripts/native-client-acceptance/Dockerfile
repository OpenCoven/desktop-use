FROM node:24-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS node
FROM rust:bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && apt-get update && apt-get install -y --no-install-recommends python3-gi python3-cairo gir1.2-gtk-3.0 xvfb xauth openbox scrot maim xdotool wmctrl x11-utils dbus-x11 && rm -rf /var/lib/apt/lists/*
WORKDIR /owned/source
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
COPY contracts ./contracts
COPY vendor ./vendor
RUN cargo build --locked
COPY fixture /owned/fixture
COPY acceptance /owned/acceptance
COPY pty-host.py /owned/pty-host.py
COPY candidate.tgz /owned/candidate.tgz
RUN mkdir /owned/consumer && cd /owned/consumer && printf '{"private":true,"type":"module"}' > package.json && npm install --ignore-scripts --no-audit --no-fund /owned/candidate.tgz @modelcontextprotocol/client@2.4.0 && cp /owned/acceptance/*.mjs .
COPY acceptance/linux-image-proof.py /owned/linux-image-proof.py
COPY acceptance/active-cancellation.py /owned/active-cancellation.py
COPY acceptance/owned_process_guard.py /owned/owned_process_guard.py
WORKDIR /owned
CMD ["sleep", "infinity"]
