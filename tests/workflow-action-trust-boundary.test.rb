require "yaml"
require "pathname"

ALLOWED_EXTERNAL_ACTIONS = ["actions/checkout"].freeze

def external_action_identity(reference)
  return nil unless reference.is_a?(String)
  return nil if reference.start_with?("./")
  return "docker://" if reference.start_with?("docker://")

  target = reference.split("@", 2).first
  parts = target.split("/")
  return target if parts.length < 2
  parts.first(2).join("/")
end

def action_trust_findings(parsed, relative)
  findings = []
  return findings unless parsed.is_a?(Hash)
  jobs = parsed["jobs"]
  return findings unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)

    if job["uses"].is_a?(String)
      identity = external_action_identity(job["uses"])
      if identity && !ALLOWED_EXTERNAL_ACTIONS.include?(identity)
        findings << "#{relative}: job #{job_name.inspect} uses unapproved external reusable workflow/action #{job["uses"].inspect}"
      end
    end

    steps = job["steps"]
    next unless steps.is_a?(Array)
    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash) && step["uses"].is_a?(String)
      reference = step["uses"]
      identity = external_action_identity(reference)
      next unless identity
      next if ALLOWED_EXTERNAL_ACTIONS.include?(identity)

      findings << "#{relative}: job #{job_name.inspect} step ##{index + 1} uses unapproved external action #{reference.inspect}"
    end
  end

  findings
end

checkout_fixture = YAML.safe_load(<<~YAML)
  jobs:
    validate:
      steps:
        - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
YAML
raise "checkout allowlist self-test failed" unless action_trust_findings(checkout_fixture, "fixture.yml").empty?

local_reuse_fixture = YAML.safe_load(<<~YAML)
  jobs:
    validate:
      uses: ./.github/workflows/reusable.yml
YAML
raise "local reusable workflow self-test failed" unless action_trust_findings(local_reuse_fixture, "fixture.yml").empty?

[
  ["unapproved official action", "jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@0123456789012345678901234567890123456789\n"],
  ["third-party action", "jobs:\n  test:\n    steps:\n      - uses: vendor/tool@0123456789012345678901234567890123456789\n"],
  ["docker action", "jobs:\n  test:\n    steps:\n      - uses: docker://alpine@sha256:#{"a" * 64}\n"],
  ["external reusable workflow", "jobs:\n  test:\n    uses: owner/repo/.github/workflows/reusable.yml@0123456789012345678901234567890123456789\n"],
].each do |label, source|
  findings = action_trust_findings(YAML.safe_load(source), "fixture.yml")
  raise "#{label} self-test failed" unless findings.length == 1
end

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
  findings.concat(action_trust_findings(parsed, relative))
end

unless findings.empty?
  abort "Workflow external-action trust boundary failed. Allowed: #{ALLOWED_EXTERNAL_ACTIONS.join(", ")}\n#{findings.join("\n")}"
end

puts "Workflow action trust boundary passed for #{workflows.length} workflows; allowed external actions: #{ALLOWED_EXTERNAL_ACTIONS.join(", ")}"
