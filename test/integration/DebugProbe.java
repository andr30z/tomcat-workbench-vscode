import com.sun.jdi.Bootstrap;
import com.sun.jdi.Method;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import java.util.Map;

// Real JDI client: prove that a request reaches a breakpoint, then resume and detach.
public class DebugProbe {
    private static void breakpoint(VirtualMachine vm, ReferenceType type) {
        for (Method method : type.methodsByName("doFilter")) {
            if (!method.isAbstract() && method.location() != null) {
                BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(method.location());
                request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                request.enable();
                return;
            }
        }
        throw new IllegalStateException("No doFilter method in ApplicationFilterChain");
    }
    public static void main(String[] values) throws Exception {
        AttachingConnector socket = null;
        for (AttachingConnector candidate : Bootstrap.virtualMachineManager().attachingConnectors()) {
            if (candidate.name().equals("com.sun.jdi.SocketAttach")) socket = candidate;
        }
        if (socket == null) throw new IllegalStateException("SocketAttach unavailable");
        Map<String, Connector.Argument> options = socket.defaultArguments();
        options.get("hostname").setValue("127.0.0.1");
        options.get("port").setValue(values[0]);
        options.get("timeout").setValue("10000");
        VirtualMachine vm = socket.attach(options);
        try {
            String target = "org.apache.catalina.core.ApplicationFilterChain";
            ClassPrepareRequest prepare = vm.eventRequestManager().createClassPrepareRequest();
            prepare.addClassFilter(target);
            prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            prepare.enable();
            for (ReferenceType type : vm.classesByName(target)) breakpoint(vm, type);
            System.out.println("ATTACHED");
            System.out.flush();
            vm.resume();
            long deadline = System.currentTimeMillis() + 20000;
            while (System.currentTimeMillis() < deadline) {
                EventSet events = vm.eventQueue().remove(1000);
                if (events == null) continue;
                boolean hit = false;
                for (Event event : events) {
                    if (event instanceof ClassPrepareEvent) breakpoint(vm, ((ClassPrepareEvent)event).referenceType());
                    if (event instanceof BreakpointEvent) {
                        System.out.println("BREAKPOINT_HIT:" + ((BreakpointEvent)event).location().method().name());
                        hit = true;
                    }
                }
                events.resume();
                if (hit) return;
            }
            throw new IllegalStateException("Breakpoint was not hit");
        } finally { vm.dispose(); }
    }
}
