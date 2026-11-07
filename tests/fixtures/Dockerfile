FROM node:26.8.2-bookworm-slim@sha256:6e685d638c472d81fdf86b944e3487f0d3b5e747d5099f936d4d2256cd1201d5
WORKDIR /fixture
COPY --chown=node:node server.mjs cluster-check.mjs ./
USER node
EXPOSE 8443
ENTRYPOINT ["node", "server.mjs"]
CMD ["/run/servicedns.podcert.ate.dev/credential-bundle.pem"]
