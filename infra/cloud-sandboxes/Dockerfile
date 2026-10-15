FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ZUSE_PROVISION_DIR=/opt/zuse-provision

# Shared runtime/layout installation lives in provision.sh. E2B also installs
# pinned agents; the Boat publisher preserves its provider-bundled agents.
COPY --chmod=0755 install-grok.sh provision.sh /opt/zuse-provision/

RUN /opt/zuse-provision/provision.sh packages

RUN /opt/zuse-provision/provision.sh globals

# These tarballs are built from this checkout. The current server/serve release
# is intentionally not fetched from npm: the sandbox external-bind behavior
# must ship atomically with the api that depends on it.
COPY artifacts /opt/zuse-provision/artifacts
COPY sshd_config project-builder.sh workspace-bootstrap.sh workspace-runtime.sh git-askpass.sh github-auth.sh repository-script.ts /opt/zuse-provision/

RUN /opt/zuse-provision/provision.sh runtime layout \
	&& rm -rf /opt/zuse-provision

USER zuse
WORKDIR /home/zuse

# The api starts Zuse through envd after Sandbox.create. Create-time env vars
# are intentionally not consumed by an image start command.
CMD ["sleep", "infinity"]
