require "yaml"
require "pathname"

# Persistent VPS runners may execute pull-request source only under the
# canonical owner/same-repository admission guard. Hosted runners are forbidden
# by the owner's zero-billing policy; mutable/dynamic runner labels or relaxed
# expressions must never satisfy this source-boundary contract.
VPS_PR_RUNNERS = %w[self-hosted portfolio-pool vps].freeze
VPS_OWNER_PR_GUARD = "((github.event_name != 'pull_request' && " \
  "github.event_name != 'pull_request_target') || " \
  "(github.event.pull_request.head.repo.full_name == github.repository && " \
  "github.actor == 'Zennay'))".freeze

def pull_request_trigger?(parsed)
  # YAML 1.1/Psych may parse `on` as boolean true. Inspect the parsed
  # Action events, not indentation or spelling: sequence and flow styles
  # must not bypass the owner-guarded persistent-runner admission check.
  return false unless parsed.is_a?(Hash)
  events = parsed.key?("on") ? parsed["on"] : parsed[true]
  protected_events = ["pull_request", "pull_request_target"]
  case events
  when Hash then events.keys.any? { |event| protected_events.include?(event) }
  when Array then events.any? { |event| protected_events.include?(event) }
  when String then protected_events.include?(events)
  else false
  end
end

def admitted_vps_pr_job?(job)
  job.is_a?(Hash) &&
    job["runs-on"] == VPS_PR_RUNNERS &&
    job["if"] == VPS_OWNER_PR_GUARD
end

def pr_runner_boundary_findings(source, parsed, relative)
  return [] unless pull_request_trigger?(parsed)
  return ["#{relative}: PR workflow must declare jobs"] unless parsed.is_a?(Hash) && parsed["jobs"].is_a?(Hash)

  parsed["jobs"].filter_map do |job_name, job|
    next if admitted_vps_pr_job?(job)
    "#{relative}: pull_request job #{job_name.inspect} requires exact VPS labels and owner/same-repository admission guard"
  end
end

def fixture(runner:, guard: VPS_OWNER_PR_GUARD, event: "pull_request")
  YAML.safe_load("on:\n  #{event}:\njobs:\n  test:\n    runs-on: #{runner}\n    if: #{guard}\n")
end

safe_source = "on:\n  pull_request:\njobs:\n  test:\n    runs-on: [self-hosted, portfolio-pool, vps]\n    if: #{VPS_OWNER_PR_GUARD}\n"
raise "valid VPS PR owner admission falsely denied" unless pr_runner_boundary_findings(
  safe_source, YAML.safe_load(safe_source), "fixture.yml"
).empty?

# Every known bypass must fail closed, even if it appears to have safe labels.
[
  "ubuntu-latest", "self-hosted", "[self-hosted, zcloud, vps]",
  "[self-hosted, portfolio-pool]", "[self-hosted, portfolio-pool, vps, extra]",
  "${{ matrix.runner }}",
  "{group: private-runners, labels: [self-hosted, portfolio-pool, vps]}",
  "{group: private-runners, labels: ubuntu-latest}",
  "[ubuntu-latest, portfolio-pool, vps]"
].each do |runner|
  source = "on:\n  pull_request:\njobs:\n  test:\n    runs-on: #{runner}\n    if: #{VPS_OWNER_PR_GUARD}\n"
  findings = pr_runner_boundary_findings(source, YAML.safe_load(source), "fixture.yml")
  raise "PR runner labels bypass: #{runner}" if findings.empty?
end

[
  "true",
  "github.actor == 'Zennay'",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "github.actor == 'somebody-else'",
  "((github.event_name != 'pull_request') || github.actor == 'Zennay')",
  "${{ github.actor == 'Zennay' }}",
  "((github.event_name != 'pull_request' && github.event_name != 'pull_request_target') || (github.event.pull_request.head.repo.full_name == github.repository))"
].each do |guard|
  source = "on:\n  pull_request:\njobs:\n  test:\n    runs-on: [self-hosted, portfolio-pool, vps]\n    if: #{guard}\n"
  raise "PR admission guard bypass: #{guard}" if pr_runner_boundary_findings(
    source, YAML.safe_load(source), "fixture.yml"
  ).empty?
end

# GitHub Actions accepts scalar, flow-map and flow-sequence event spellings.
# A source-text indentation matcher misses them; require the same VPS+owner
# boundary for every native Actions trigger representation.
[
  "on: [pull_request]",
  "on: pull_request",
  "on: {pull_request: {}}",
  "on: [push, pull_request_target]",
  "on: {push: {}, pull_request_target: {}}"
].each do |event_definition|
  source = "#{event_definition}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    if: #{VPS_OWNER_PR_GUARD}\n"
  parsed = YAML.safe_load(source)
  raise "PR trigger variant not recognized: #{event_definition}" unless pull_request_trigger?(parsed)
  raise "PR trigger variant bypass: #{event_definition}" if pr_runner_boundary_findings(
    source, parsed, "fixture.yml"
  ).empty?
end

# Even a pull_request_target workflow cannot execute on a persistent VPS
# without the identical exact guard. Manual-only workflows are not PR exposure.
target_source = safe_source.sub("pull_request:", "pull_request_target:")
raise "PR target owner gate falsely denied" unless pr_runner_boundary_findings(
  target_source, YAML.safe_load(target_source), "fixture.yml"
).empty?
manual_source = safe_source.sub("pull_request:", "workflow_dispatch:")
raise "manual-only workflow false positive" unless pr_runner_boundary_findings(
  manual_source, YAML.safe_load(manual_source), "fixture.yml"
).empty?

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }
abort "No GitHub Actions workflows found" if workflows.empty?

findings = []
pull_request_workflows = 0
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  source = File.read(workflow, encoding: "UTF-8")
  parsed = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: true)
  pull_request_workflows += 1 if pull_request_trigger?(parsed)
  findings.concat(pr_runner_boundary_findings(source, parsed, relative))
end

abort "No pull_request workflows were discovered" if pull_request_workflows.zero?
unless findings.empty?
  abort "Pull-request VPS-only owner boundary failed:\n#{findings.join("\n")}"
end

puts "Pull-request VPS-only owner boundary passed for #{pull_request_workflows} PR workflows across #{workflows.length} workflows"
