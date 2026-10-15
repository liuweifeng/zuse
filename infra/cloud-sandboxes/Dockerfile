FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ZUSE_PROVISION_DIR=/tmp/zuse-provision

COPY --chmod=0755 install-grok.sh provision.sh /tmp/zuse-provision/

RUN /tmp/zuse-provision/provision.sh packages

RUN /tmp/zuse-provision/provision.sh globals

COPY artifacts /tmp/zuse-provision/artifacts
COPY sshd_config project-builder.sh workspace-bootstrap.sh workspace-runtime.sh git-askpass.sh github-auth.sh repository-script.ts /tmp/zuse-provision/

RUN /tmp/zuse-provision/provision.sh runtime layout \
	&& rm -rf /tmp/zuse-provision

USER zuse
WORKDIR /home/zuse

CMD ["sleep", "infinity"]
