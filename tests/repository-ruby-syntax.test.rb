# frozen_string_literal: true

require "pathname"

ROOT = Pathname(__dir__).parent

def tracked_ruby_files
  output = IO.popen(["git", "ls-files", "-z"], chdir: ROOT.to_s, &:read)
  output.split("\0").reject(&:empty?).map { |path| Pathname(path) }.select { |path| path.extname == ".rb" }.sort
end

def compile_ruby(source, filename)
  RubyVM::InstructionSequence.compile(source, filename, filename, 1)
end

compile_ruby("value = 1\nputs value\n", "self-test-valid.rb")

begin
  compile_ruby("def broken(\nend\n", "self-test-invalid.rb")
rescue SyntaxError
  # Expected: prove the parser rejects invalid Ruby before validating repository files.
else
  raise "self-test-invalid.rb must raise SyntaxError"
end

ruby_files = tracked_ruby_files
raise "repository must contain tracked Ruby files" if ruby_files.empty?

ruby_files.each do |ruby_file|
  source = (ROOT / ruby_file).read(encoding: "UTF-8")
  begin
    compile_ruby(source, ruby_file.to_s)
  rescue SyntaxError => error
    message = error.message.lines.first&.strip || "Ruby syntax error"
    raise "#{ruby_file}: #{message}"
  end
end

puts "Repository Ruby syntax contract passed for #{ruby_files.length} tracked files"
