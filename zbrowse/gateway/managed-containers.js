export async function cleanupManagedContainers(docker) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ["zbrowse.managed=true"] }
  });

  await Promise.all(containers.map(async ({ Id }) => {
    if (!Id) throw new Error("Managed browser container is missing an id.");
    await docker.getContainer(Id).remove({ force: true });
  }));

  return containers.length;
}
