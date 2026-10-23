FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ZUSE_PROVISION_DIR=/opt/zuse-provision



COPY --chmod=0755 install-grok.sh provision.sh /opt/zuse-provision/

RUN /opt/zuse-provision/provision.sh packages

RUN /opt/zuse-provision/provision.sh globals




COPY artifacts /opt/zuse-provision/artifacts
COPY sshd_config project-builder.sh workspace-bootstrap.sh workspace-runtime.sh git-askpass.sh github-auth.sh repository-script.ts /opt/zuse-provision/

RUN /opt/zuse-provision/provision.sh runtime layout \
	&& rm -rf /opt/zuse-provision

USER zuse
WORKDIR /home/zuse



CMD ["sleep", "infinity"]
