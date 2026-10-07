require "yaml"
require "pathname"

def local_action_references(parsed, relative)
  findings = []
  return findings unless parsed.is_a?(Hash)
  jobs = parsed["jobs"]
  return findings unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)
    steps = job["steps"]
    next unless steps.is_a?(Array)

    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash)
      reference = step["uses"]
      next unless reference.is_a?(String)
      next unless reference.start_with?("./")

      findings << "#{relative}: job #{job_name.inspect} step ##{index + 1} uses local action #{reference.inspect}"
    end
  end

  findings
end

local_fixture = YAML.safe_load(<<~YAML)
  jobs:
    validate:
      steps:
        - uses: ./.github/actions/example
YAML
raise "local-action self-test failed" unless local_action_references(local_fixture, "fixture.yml").length == 1

external_fixture = YAML.safe_load(<<~YAML)
  jobs:
    validate:
      steps:
        - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
YAML
raise "external-action self-test failed" unless local_action_references(external_fixture, "fixture.yml").empty?

job_reuse_fixture = YAML.safe_load(<<~YAML)
  jobs:
    validate:
      uses: ./.github/workflows/reusable.yml
YAML
raise "reusable-workflow self-test failed" unless local_action_references(job_reuse_fixture, "fixture.yml").empty?

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

findings = []
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  parsed = YAML.safe_load(
    File.read(workflow, encoding: "UTF-8"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )
  findings.concat(local_action_references(parsed, relative))
end

unless findings.empty?
  abort "Local step actions are forbidden because workflow-action pinning cannot prove their transitive action provenance:\n#{findings.join("\n")}"
end

puts "Workflow local-action boundary passed for #{workflows.length} workflows"
