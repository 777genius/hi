#include <arpa/inet.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static int frontend_ready(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons(1425);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    int ready = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0;
    close(fd);
    return ready;
}

static int ensure_frontend(const char *macos_dir) {
    if (frontend_ready()) return 1;

    char script[4096];
    char frontend[4096];
    snprintf(script, sizeof(script), "%s/../Resources/serve_frontend.py", macos_dir);
    snprintf(frontend, sizeof(frontend), "%s/../Resources/frontend", macos_dir);

    pid_t app_pid = getpid();
    pid_t child = fork();
    if (child == 0) {
        char parent_pid[32];
        snprintf(parent_pid, sizeof(parent_pid), "%ld", (long)app_pid);
        execl("/usr/bin/python3", "python3", script, frontend, parent_pid, (char *)NULL);
        _exit(127);
    }
    if (child < 0) return 0;

    for (int attempt = 0; attempt < 40; attempt++) {
        if (frontend_ready()) return 1;
        usleep(100000);
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc;
    const char *home = getenv("HOME");
    if (!home) return 1;

    char envfile[4096];
    snprintf(envfile, sizeof(envfile), "%s/.local/share/hackinterview-sub2api/hackinterview-llm.env", home);
    FILE *file = fopen(envfile, "r");
    if (!file) { perror("HackInterview configuration"); return 1; }
    const char *allowed[] = {"LLM_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_RESPONSES_MODEL", "OPENAI_RESPONSES_REASONING_EFFORT"};
    char *line = NULL;
    size_t cap = 0;
    while (getline(&line, &cap, file) > 0) {
        char *equal = strchr(line, '=');
        if (!equal) continue;
        *equal++ = '\0';
        for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
            if (strcmp(line, allowed[i]) == 0) {
                equal[strcspn(equal, "\r\n")] = '\0';
                setenv(allowed[i], equal, 1);
                break;
            }
        }
    }
    free(line);
    fclose(file);

    setenv("HACKINTERVIEW_LOCAL_NO_AUTH", "1", 1);
    setenv("VITE_API_URL", "https://api.voicetext.site", 1);
    setenv("VOICE_TO_TEXT_BACKEND_URL", "wss://api.voicetext.site", 1);

    char path[4096];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) != 0) return 1;
    char *macos_dir = dirname(path);
    if (!ensure_frontend(macos_dir)) {
        fprintf(stderr, "HackInterview frontend did not start\n");
        return 1;
    }

    char core[4096];
    snprintf(core, sizeof(core), "%s/HackInterviewCore", macos_dir);
    argv[0] = core;
    execv(core, argv);
    perror("HackInterviewCore");
    return 1;
}
