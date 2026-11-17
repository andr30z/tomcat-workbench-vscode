import com.sun.jdi.Bootstrap;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.Map;
public class HotSwapProbe {
    public static void main(String[] args) throws Exception {
        AttachingConnector socket = null;
        for (AttachingConnector candidate : Bootstrap.virtualMachineManager().attachingConnectors())
            if (candidate.name().equals("com.sun.jdi.SocketAttach")) socket = candidate;
        if (socket == null) throw new IllegalStateException("SocketAttach missing");
        Map<String, Connector.Argument> options = socket.defaultArguments();
        options.get("hostname").setValue("127.0.0.1"); options.get("port").setValue(args[0]); options.get("timeout").setValue("10000");
        VirtualMachine vm = socket.attach(options);
        try {
            if (!vm.canRedefineClasses()) throw new IllegalStateException("HotSwap unsupported");
            if (vm.classesByName(args[1]).isEmpty()) throw new IllegalStateException("Class not loaded");
            ReferenceType type = vm.classesByName(args[1]).get(0);
            vm.redefineClasses(Collections.singletonMap(type, Files.readAllBytes(Paths.get(args[2]))));
            System.out.println("REDEFINED");
        } finally { vm.dispose(); }
    }
}
