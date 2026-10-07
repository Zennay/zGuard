require "yaml"
require "pathname"

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir[workflow_dir.join("*.{yml,yaml}")].sort

abort "No GitHub Actions workflows found" if workflows.empty?

workflows.each do |workflow|
  relative = Pathname.new(workflow).relative_path_from(root).to_s
  source = File.read(workflow, encoding: "UTF-8")

  begin
    parsed = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: true)
  rescue Psych::SyntaxError => error
    abort "#{relative}: invalid YAML at line #{error.line}, column #{error.column}: #{error.problem}"
  end

  abort "#{relative}: workflow root must be a mapping" unless parsed.is_a?(Hash)

  jobs = parsed["jobs"]
  abort "#{relative}: workflow must define a non-empty jobs mapping" unless jobs.is_a?(Hash) && !jobs.empty?

  jobs.each do |job_name, job|
    abort "#{relative}: job #{job_name.inspect} must be a mapping" unless job.is_a?(Hash)
  end
end

puts "Workflow YAML syntax contract passed for #{workflows.length} workflows"
