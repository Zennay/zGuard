require "psych"
require "pathname"

def duplicate_mapping_keys(node, path = [], findings = [])
  if node.is_a?(Psych::Nodes::Mapping)
    seen = {}

    node.children.each_slice(2) do |key_node, value_node|
      segment = key_node.is_a?(Psych::Nodes::Scalar) ? key_node.value : "<complex-key>"

      if key_node.is_a?(Psych::Nodes::Scalar)
        identity = [key_node.tag, key_node.value]
        if seen.key?(identity)
          findings << {
            key: key_node.value,
            path: (path + [segment]).join("."),
            line: key_node.start_line + 1,
            first_line: seen[identity]
          }
        else
          seen[identity] = key_node.start_line + 1
        end
      end

      duplicate_mapping_keys(key_node, path, findings)
      duplicate_mapping_keys(value_node, path + [segment], findings)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| duplicate_mapping_keys(child, path, findings) }
  end

  findings
end

def parse_yaml(source, label)
  syntax_tree = Psych.parse_stream(source)
  duplicates = duplicate_mapping_keys(syntax_tree)

  unless duplicates.empty?
    detail = duplicates.map do |finding|
      "#{finding[:path]} at line #{finding[:line]} (first defined at line #{finding[:first_line]})"
    end.join(", ")
    abort "#{label}: duplicate YAML mapping keys: #{detail}"
  end

  syntax_tree
rescue Psych::SyntaxError => error
  abort "#{label}: invalid YAML at line #{error.line}, column #{error.column}: #{error.problem}"
end

def yaml_path?(path)
  [".yml", ".yaml"].include?(File.extname(path).downcase)
end

valid_self_test = <<~YAML
  services:
    gateway:
      image: example/gateway:1
      environment:
        PORT: 8090
YAML
parse_yaml(valid_self_test, "self-test valid")

duplicate_self_test = <<~YAML
  services:
    gateway:
      image: example/gateway:1
      image: example/gateway:2
YAML
begin
  parse_yaml(duplicate_self_test, "self-test duplicate")
  abort "Duplicate-key detector self-test failed"
rescue SystemExit => error
  raise unless error.status == 1
end

invalid_self_test = "services:\n  gateway: [unterminated\n"
begin
  parse_yaml(invalid_self_test, "self-test syntax")
  abort "YAML syntax detector self-test failed"
rescue SystemExit => error
  raise unless error.status == 1
end

{
  "config.yml" => true,
  "CONFIG.YML" => true,
  "workflow.YaMl" => true,
  "config.yaml.txt" => false,
  "yaml" => false
}.each do |path, expected|
  actual = yaml_path?(path)
  abort "YAML path discovery self-test failed for #{path}: expected #{expected}, got #{actual}" unless actual == expected
end

root = Pathname.new(__dir__).parent
tracked = IO.popen(["git", "ls-files", "-z"], chdir: root.to_s, &:read).split("\0").reject(&:empty?)
yaml_files = tracked.select { |file| yaml_path?(file) }.sort

abort "No tracked YAML files found" if yaml_files.empty?
abort "zbrowse/docker-compose.yml must remain covered by repository YAML validation" unless yaml_files.include?("zbrowse/docker-compose.yml")

yaml_files.each do |relative|
  source = File.read(root.join(relative), encoding: "UTF-8")
  parse_yaml(source, relative)
end

puts "Repository YAML syntax and duplicate-key integrity passed for #{yaml_files.length} tracked files"
