require "yaml"
require "pathname"

DIGEST_IMAGE = /\A[^\s@]+@sha256:[0-9a-f]{64}\z/i

def immutable_container_image?(image)
  image.is_a?(String) &&
    !image.empty? &&
    !image.include?("${{") &&
    DIGEST_IMAGE.match?(image)
end

good_image = "ghcr.io/example/tool:1.2.3@sha256:#{"a" * 64}"
raise "digest image self-test failed" unless immutable_container_image?(good_image)
raise "mutable tag self-test failed" if immutable_container_image?("ghcr.io/example/tool:latest")
raise "expression image self-test failed" if immutable_container_image?("${{ matrix.image }}")
raise "short digest self-test failed" if immutable_container_image?("ghcr.io/example/tool@sha256:#{"a" * 63}")

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

validated = 0

workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  parsed = YAML.safe_load(
    File.read(workflow, encoding: "UTF-8"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )

  next unless parsed.is_a?(Hash)
  jobs = parsed["jobs"]
  next unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)

    if job.key?("container")
      container = job["container"]
      image = container.is_a?(Hash) ? container["image"] : container
      unless immutable_container_image?(image)
        abort "#{relative}: job #{job_name.inspect} container image must be pinned by sha256 digest; got #{image.inspect}"
      end
      validated += 1
    end

    services = job["services"]
    next unless services

    unless services.is_a?(Hash)
      abort "#{relative}: job #{job_name.inspect} services must be a mapping"
    end

    services.each do |service_name, service|
      image = service.is_a?(Hash) ? service["image"] : nil
      unless immutable_container_image?(image)
        abort "#{relative}: job #{job_name.inspect} service #{service_name.inspect} image must be pinned by sha256 digest; got #{image.inspect}"
      end
      validated += 1
    end
  end
end

puts "Workflow container/service image provenance passed for #{workflows.length} workflows (#{validated} pinned image references)"
